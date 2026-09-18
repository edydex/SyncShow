'use strict';

const crypto = require('crypto');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  addGroupItem,
  addProjectItem,
  addSermonResource,
  bindProjectAsPowerPointCompanion,
  compileServiceProject,
  createServiceProject,
  resolveSermonSourceLink,
  setSermonSourceLink
} = require('../src/services/project/ServiceProject');
const {
  MAX_PROJECT_TEXT_CHARS,
  SermonCueReconciliationError,
  applySermonCueReconciliation,
  buildSermonCueReconciliationProposal,
  serviceProjectRevisionId
} = require('../src/services/project/SermonCueReconciliation');

const NOW = '2026-07-28T16:00:00.000Z';
const PPTX_MEDIA_TYPE =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function canonicalHash(value) {
  return crypto.createHash('sha256')
    .update(`${canonicalJson(value)}\n`)
    .digest('hex');
}

function withRecomputedProposalId(proposal) {
  const next = clone(proposal);
  delete next.id;
  next.id = canonicalHash(next);
  return next;
}

function source(id, language, shaCharacter) {
  return {
    id,
    kind: 'slide-notes',
    fileName: `${id}.pptx`,
    mediaType: PPTX_MEDIA_TYPE,
    sha256: shaCharacter.repeat(64),
    sizeBytes: 4096,
    languages: [language],
    provenance: {
      providedBy: '',
      receivedAt: NOW,
      sourceSystem: 'service-set',
      externalId: `service-set:${shaCharacter.repeat(64)}`
    }
  };
}

function sermonDocument() {
  return {
    schemaVersion: 3,
    kind: 'syncshow-sermon',
    id: 'sermon-reconciliation',
    titles: {
      en: 'Faithful sermon notes',
      ru: 'Верные заметки проповеди'
    },
    defaultLanguage: 'en',
    speaker: {
      id: 'pastor-example',
      name: 'Pastor Example'
    },
    serviceDate: '2026-07-28',
    series: null,
    outline: [{
      id: 'section-i',
      parentId: null,
      kind: 'section',
      titles: { en: 'I. Foundation', ru: 'I. Основание' }
    }, {
      id: 'section-ii',
      parentId: null,
      kind: 'section',
      titles: { en: 'II. Content', ru: 'II. Содержание' }
    }, {
      id: 'section-iii',
      parentId: null,
      kind: 'section',
      titles: { en: 'III. Result', ru: 'III. Результат' }
    }],
    sources: [
      source('slides-en', 'en', 'a'),
      source('slides-ru', 'ru', 'b'),
      source('slides-media', 'und', 'c')
    ],
    references: [],
    media: [],
    publication: {
      status: 'draft',
      visibility: 'private',
      publishedAt: null,
      canonicalUrl: null
    },
    body: []
  };
}

function linkedProject({ nonempty = false } = {}) {
  let project = createServiceProject({
    id: 'service-reconciliation',
    title: 'Sunday Service',
    serviceDate: '2026-07-28',
    profileId: 'sanctuary',
    now: NOW,
    channels: [
      { id: 'primary', label: 'Russian', language: 'ru' },
      { id: 'secondary', label: 'English', language: 'en' },
      { id: 'media', label: 'Media', language: 'und' }
    ]
  });
  const pinned = addSermonResource(project, sermonDocument());
  project = addGroupItem(pinned.project, {
    id: 'sermon-anchor',
    title: 'Sermon',
    groupKind: 'sermon',
    sermonResourceId: pinned.resourceId,
    now: NOW
  });
  if (nonempty) {
    project = addProjectItem(project, {
      id: 'existing-sermon-cue',
      kind: 'sermon',
      title: 'Existing',
      textByChannel: { secondary: 'Existing cue' },
      presetId: 'sermon-notes',
      operatorNotes: ''
    }, {
      parentId: 'sermon-anchor',
      now: NOW
    });
  }
  return {
    project,
    sermon: project.resources[pinned.resourceId].document,
    resourceId: pinned.resourceId,
    sermonRevisionId: pinned.resourceId.slice('sha256:'.length)
  };
}

function nestedLinkedProject() {
  const fixture = linkedProject();
  let project = addGroupItem(fixture.project, {
    id: 'sermon-point-one',
    title: 'I. Foundation',
    groupKind: 'point',
    sermonSectionId: 'section-i',
    parentId: 'sermon-anchor',
    now: NOW
  });
  project = addProjectItem(project, {
    id: 'nested-existing-cue',
    kind: 'sermon',
    title: 'Existing nested cue',
    titlesByChannel: {
      primary: 'Old mapped Russian title',
      secondary: 'Old mapped English title',
      media: 'Preserved media title'
    },
    textByChannel: {
      primary: 'Old mapped Russian text',
      secondary: 'Old mapped English text',
      media: 'Preserved media text'
    },
    presetId: 'sermon-notes',
    operatorNotes: 'Preserve nested note',
    sermonSectionId: 'section-ii'
  }, {
    parentId: 'sermon-point-one',
    now: NOW
  });
  project = addGroupItem(project, {
    id: 'nested-subpoint',
    title: 'Nested subgroup remains opaque',
    groupKind: 'subpoint',
    parentId: 'sermon-point-one',
    now: NOW
  });
  project = addProjectItem(project, {
    id: 'grandchild-sermon-cue',
    kind: 'sermon',
    title: 'Grandchild cue',
    textByChannel: { secondary: 'Grandchild text' },
    presetId: 'sermon-notes',
    operatorNotes: ''
  }, {
    parentId: 'nested-subpoint',
    now: NOW
  });
  project = addGroupItem(project, {
    id: 'sermon-point-two',
    title: 'II. Content',
    groupKind: 'point',
    sermonSectionId: 'section-ii',
    parentId: 'sermon-anchor',
    now: NOW
  });
  project = addProjectItem(project, {
    id: 'sibling-sermon-cue',
    kind: 'sermon',
    title: 'Sibling cue',
    textByChannel: { secondary: 'Sibling text' },
    presetId: 'sermon-notes',
    operatorNotes: ''
  }, {
    parentId: 'sermon-point-two',
    now: NOW
  });
  return {
    ...fixture,
    project
  };
}

function extractionFor(
  sermonSource,
  texts,
  {
    scopeStrategy = 'pptx-roman-outline-window',
    truncated = {},
    schemaVersion = 1,
    extractorVersion = 1,
    spansByUnit = {}
  } = {}
) {
  const units = texts.map((text, index) => ({
    id: `${sermonSource.id}-slide-${index + 1}`,
    kind: 'slide',
    ordinal: index + 1,
    label: `${sermonSource.fileName} · Slide ${index + 1}`,
    text,
    ...(spansByUnit[index]?.length > 0 ? { spans: spansByUnit[index] } : {}),
    truncated: truncated.unitIndex === index
  }));
  const noWindow = scopeStrategy === 'pptx-no-sermon-window';
  const outlineUnitIndexes = [
    0,
    Math.floor((units.length - 1) / 2),
    units.length - 1
  ];
  return {
    schemaVersion,
    kind: 'syncshow-sermon-source-extraction-proposal',
    extractor: {
      id: 'syncshow-deterministic-source-extractor',
      version: extractorVersion
    },
    source: {
      id: sermonSource.id,
      sha256: sermonSource.sha256,
      kind: sermonSource.kind,
      languages: sermonSource.languages,
      mediaType: sermonSource.mediaType
    },
    units,
    textPreview: texts.join('\n\n').slice(0, 1000),
    suggestionScope: {
      strategy: scopeStrategy,
      startUnitId: noWindow ? null : units[0].id,
      endUnitId: noWindow ? null : units[units.length - 1].id,
      startOrdinal: noWindow ? null : 1,
      endOrdinal: noWindow ? null : units.length
    },
    outlineSuggestions: ['I', 'II', 'III'].map((marker, index) => ({
      id: `outline-${sermonSource.id}-${marker.toLowerCase()}`,
      level: 1,
      marker,
      parentId: null,
      parentSuggestionId: null,
      suggestedKind: 'section',
      titles: { [sermonSource.languages[0]]: `${marker}. Point` },
      rawText: `${marker}. Point`,
      sourceUnitIds: noWindow
        ? []
        : [units[outlineUnitIndexes[index]].id],
      sourceUnitIdsTruncated: false,
      occurrenceCount: 1
    })),
    scriptureReferenceSuggestions: [],
    truncated: {
      units: truncated.units === true,
      text: truncated.text === true,
      preview: false,
      outlineSuggestions: truncated.outlineSuggestions === true,
      scriptureReferences: false
    }
  };
}

function snapshotFor(sermon, sermonRevisionId, sourceId, texts, extractionOptions) {
  const sermonSource = sermon.sources.find(candidate => candidate.id === sourceId);
  const extraction = extractionFor(sermonSource, texts, extractionOptions);
  const binding = {
    sermonId: sermon.id,
    baseSermonRevisionId: sermonRevisionId,
    sourceId: sermonSource.id,
    sourceSha256: sermonSource.sha256,
    sourceKind: sermonSource.kind,
    extractorId: extraction.extractor.id,
    extractorVersion: extraction.extractor.version
  };
  const record = {
    schemaVersion: 1,
    kind: 'syncshow-sermon-extraction-snapshot',
    binding,
    extraction
  };
  return {
    snapshotHash: canonicalHash(record),
    binding,
    extraction
  };
}

function proposalFor({
  fixture = linkedProject(),
  mappings = null,
  projectRevisionId = null,
  anchorItemId = 'sermon-anchor',
  sermonId = null,
  sermonRevisionId = null
} = {}) {
  const defaultMappings = [{
    channelId: 'primary',
    snapshot: snapshotFor(
      fixture.sermon,
      fixture.sermonRevisionId,
      'slides-ru',
      ['RU I', 'RU II', 'RU III']
    )
  }, {
    channelId: 'secondary',
    snapshot: snapshotFor(
      fixture.sermon,
      fixture.sermonRevisionId,
      'slides-en',
      ['EN I', 'EN II', 'EN III']
    )
  }];
  return buildSermonCueReconciliationProposal({
    project: fixture.project,
    projectRevisionId: projectRevisionId
      || serviceProjectRevisionId(fixture.project),
    anchorItemId,
    sermonId: sermonId || fixture.sermon.id,
    sermonRevisionId: sermonRevisionId || fixture.sermonRevisionId,
    sourceMappings: mappings || defaultMappings,
    now: NOW
  });
}

function decisionsFor(
  proposal,
  {
    skipRows = [],
    sectionByRow = {},
    overrideSelections = {},
    updateByRow = {}
  } = {}
) {
  return proposal.rows.map(row => {
    const skip = skipRows.includes(row.id);
    const targetItemId = updateByRow[row.id] || null;
    const unitsByChannel = {};
    for (const channelId of proposal.channelIds) {
      const override = overrideSelections[row.id]?.[channelId];
      const suggestion = row.suggestionsByChannel[channelId];
      const selected = override === undefined ? suggestion : override;
      unitsByChannel[channelId] = skip || selected === null
        ? null
        : {
            unitId: selected.unitId,
            text: selected.text
          };
    }
    return {
      rowId: row.id,
      action: skip ? 'skip' : (targetItemId ? 'update' : 'insert'),
      targetItemId,
      sectionId: skip ? null : (sectionByRow[row.id] || null),
      unitsByChannel
    };
  });
}

function cueIdFactory({ rowId }) {
  return `cue-${rowId}`;
}

function expectCode(code, callback) {
  assert.throws(callback, error => {
    assert.ok(error instanceof SermonCueReconciliationError);
    assert.equal(error.code, code);
    return true;
  });
}

test('aligned bilingual review inserts exact native sermon cues and compiles exact source references', () => {
  const fixture = linkedProject();
  const proposal = proposalFor({ fixture });
  assert.equal(proposal.rows.length, 3);
  assert.deepEqual(proposal.channelIds, ['primary', 'secondary']);
  assert.deepEqual(proposal.unmappedChannelIds, ['media']);
  assert.equal(
    proposal.sourceOptionsByChannel.primary.source.id,
    'slides-ru'
  );
  assert.equal(
    proposal.sourceOptionsByChannel.secondary.source.id,
    'slides-en'
  );
  assert.equal(proposal.rows[0].suggested, true);
  assert.equal(proposal.rows[0].suggestionsByChannel.primary.suggested, true);
  assert.equal(Object.isFrozen(proposal), true);
  assert.equal(Object.isFrozen(proposal.rows[0].suggestionsByChannel), true);
  assert.doesNotMatch(
    JSON.stringify(proposal),
    /(?:localPath|sourcePath|pinnedPath|\/Users\/|[A-Za-z]:\\\\)/u
  );

  const beforeBody = clone(fixture.sermon.body);
  const result = applySermonCueReconciliation({
    project: fixture.project,
    proposal,
    decisions: decisionsFor(proposal, {
      sectionByRow: {
        'row-001': 'section-i',
        'row-002': 'section-ii',
        'row-003': 'section-iii'
      }
    }),
    confirmed: true,
    idFactory: cueIdFactory
  });
  assert.equal(result.changed, true);
  assert.deepEqual(result.insertedItemIds, [
    'cue-row-001',
    'cue-row-002',
    'cue-row-003'
  ]);
  assert.deepEqual(
    result.project.items['sermon-anchor'].childIds,
    result.insertedItemIds
  );
  assert.deepEqual(
    result.project.items['cue-row-001'].textByChannel,
    { primary: 'RU I', secondary: 'EN I' }
  );
  assert.equal(result.project.items['cue-row-001'].presetId, 'sermon-notes');
  assert.equal(result.project.items['cue-row-001'].sermonSectionId, 'section-i');
  assert.deepEqual(
    result.project.resources[fixture.resourceId].document.body,
    beforeBody
  );

  const timeline = compileServiceProject(result.project);
  const firstCue = timeline.cues[timeline.cueIds[0]];
  assert.deepEqual(firstCue.sourceReference, {
    type: 'sermon-library',
    id: fixture.sermon.id,
    revision: fixture.sermonRevisionId,
    sectionId: 'section-i'
  });
  assert.equal(firstCue.channels.primary.blocks[0].text, 'RU I');
  assert.equal(firstCue.channels.secondary.blocks[0].text, 'EN I');
  assert.deepEqual(firstCue.channels.media, { mode: 'hide', blocks: [] });

  const retry = applySermonCueReconciliation({
    project: result.project,
    proposal,
    decisions: decisionsFor(proposal, {
      sectionByRow: {
        'row-001': 'section-i',
        'row-002': 'section-ii',
        'row-003': 'section-iii'
      }
    }),
    confirmed: true,
    idFactory: cueIdFactory
  });
  assert.equal(retry.unchanged, true);
  assert.deepEqual(retry.project, result.project);
});

test('apply derives inline spans only from exact trusted proposal units', () => {
  const fixture = linkedProject();
  const expectedSpans = [{
    start: 0,
    end: 2,
    foreground: '#ffc000',
    weight: '700'
  }, {
    start: 3,
    end: 4,
    foreground: '#ffc000',
    weight: '400'
  }];
  const proposal = proposalFor({
    fixture,
    mappings: [{
      channelId: 'primary',
      snapshot: snapshotFor(
        fixture.sermon,
        fixture.sermonRevisionId,
        'slides-ru',
        ['RU I', 'RU II', 'RU III'],
        {
          schemaVersion: 2,
          extractorVersion: 2,
          spansByUnit: { 0: expectedSpans }
        }
      )
    }, {
      channelId: 'secondary',
      snapshot: snapshotFor(
        fixture.sermon,
        fixture.sermonRevisionId,
        'slides-en',
        ['EN I', 'EN II', 'EN III']
      )
    }]
  });
  const decisions = decisionsFor(proposal);

  assert.equal(
    Object.prototype.hasOwnProperty.call(
      proposal.rows[0].suggestionsByChannel.primary,
      'spans'
    ),
    false
  );
  assert.deepEqual(
    decisions[0].unitsByChannel.primary,
    { unitId: 'slides-ru-slide-1', text: 'RU I' }
  );

  const result = applySermonCueReconciliation({
    project: fixture.project,
    proposal,
    decisions,
    confirmed: true,
    idFactory: cueIdFactory
  });
  assert.equal(result.project.items['cue-row-001'].title, 'RU I');
  assert.deepEqual(
    result.project.items['cue-row-001'].spansByChannel,
    { primary: expectedSpans }
  );
  const timeline = compileServiceProject(result.project);
  const firstCue = timeline.cues[timeline.cueIds[0]];
  assert.deepEqual(firstCue.channels.primary.blocks[0].spans, expectedSpans);
  assert.equal(firstCue.channels.secondary.blocks[0].spans, undefined);
  assert.deepEqual(
    result.receipt.decisions[0].unitsByChannel.primary,
    { unitId: 'slides-ru-slide-1', text: 'RU I' }
  );
});

test('decision spans and changed or invalid trusted proposal spans fail closed', () => {
  const fixture = linkedProject();
  const baseProposal = proposalFor({ fixture });
  const withSpans = clone(baseProposal);
  withSpans.sourceOptionsByChannel.secondary.units[0].spans = [{
    start: 0,
    end: 2,
    foreground: '#ffc000'
  }];
  const proposal = withRecomputedProposalId(withSpans);

  const decisionWithSpans = decisionsFor(proposal);
  decisionWithSpans[0].unitsByChannel.secondary.spans = [{
    start: 0,
    end: 2,
    foreground: '#ffffff'
  }];
  expectCode('INVALID_DECISIONS', () => applySermonCueReconciliation({
    project: fixture.project,
    proposal,
    decisions: decisionWithSpans,
    confirmed: true,
    idFactory: cueIdFactory
  }));

  const changedProposal = clone(proposal);
  changedProposal.sourceOptionsByChannel.secondary.units[0].spans[0].end = 3;
  expectCode('INVALID_PROPOSAL', () => applySermonCueReconciliation({
    project: fixture.project,
    proposal: changedProposal,
    decisions: decisionsFor(proposal),
    confirmed: true,
    idFactory: cueIdFactory
  }));

  const invalidProposal = clone(proposal);
  invalidProposal.sourceOptionsByChannel.secondary.units[0].spans[0].end = 100;
  const invalidWithMatchingId = withRecomputedProposalId(invalidProposal);
  expectCode('INVALID_PROPOSAL', () => applySermonCueReconciliation({
    project: fixture.project,
    proposal: invalidWithMatchingId,
    decisions: decisionsFor(proposal),
    confirmed: true,
    idFactory: cueIdFactory
  }));

  for (const invalidSpan of [{
    start: 0,
    end: 2,
    foreground: '#ffffff'
  }, {
    start: 0,
    end: 2,
    foreground: '#ffc000',
    weight: '600'
  }, {
    start: 0,
    end: 2,
    weight: '700'
  }]) {
    const unsupportedProposal = clone(baseProposal);
    unsupportedProposal.sourceOptionsByChannel.secondary.units[0].spans = [
      invalidSpan
    ];
    expectCode('INVALID_PROPOSAL', () => applySermonCueReconciliation({
      project: fixture.project,
      proposal: withRecomputedProposalId(unsupportedProposal),
      decisions: decisionsFor(baseProposal),
      confirmed: true,
      idFactory: cueIdFactory
    }));
  }
});

test('unsectioned cue titles use a bounded meaningful trusted text line without changing body text', () => {
  const fixture = linkedProject();
  const meaningfulLine = `${'T'.repeat(199)}😀 trailing words`;
  const exactBody = ` \n\t\n${meaningfulLine}\nSecond line`;
  const proposal = proposalFor({
    fixture,
    mappings: [{
      channelId: 'secondary',
      snapshot: snapshotFor(
        fixture.sermon,
        fixture.sermonRevisionId,
        'slides-en',
        [exactBody, 'EN II', 'EN III']
      )
    }]
  });
  const result = applySermonCueReconciliation({
    project: fixture.project,
    proposal,
    decisions: decisionsFor(proposal),
    confirmed: true,
    idFactory: cueIdFactory
  });

  assert.equal(result.project.items['cue-row-001'].title, 'T'.repeat(199));
  assert.equal(
    result.project.items['cue-row-001'].textByChannel.secondary,
    exactBody
  );
  assert.doesNotMatch(
    result.project.items['cue-row-001'].title,
    /slides-en\.pptx/u
  );
});

test('relative-position suggestions expose shorter-source gaps and every exact source option', () => {
  const fixture = linkedProject();
  const proposal = proposalFor({
    fixture,
    mappings: [{
      channelId: 'primary',
      snapshot: snapshotFor(
        fixture.sermon,
        fixture.sermonRevisionId,
        'slides-ru',
        ['RU I', 'RU II', 'RU III']
      )
    }, {
      channelId: 'secondary',
      snapshot: snapshotFor(
        fixture.sermon,
        fixture.sermonRevisionId,
        'slides-en',
        ['EN I', 'EN bridge', 'EN II', 'EN III']
      )
    }]
  });

  assert.equal(proposal.rows.length, 4);
  const unmatched = proposal.rows.filter(row =>
    row.unmatchedChannelIds.includes('primary'));
  assert.equal(unmatched.length, 1);
  assert.equal(unmatched[0].suggestionsByChannel.primary, null);
  assert.equal(unmatched[0].suggestionsByChannel.secondary.text, 'EN bridge');
  for (const channelId of proposal.channelIds) {
    const suggestedUnitIds = proposal.rows
      .map(row => row.suggestionsByChannel[channelId]?.unitId)
      .filter(Boolean);
    assert.deepEqual(
      [...suggestedUnitIds].sort(),
      proposal.sourceOptionsByChannel[channelId].units
        .map(unit => unit.unitId)
        .sort()
    );
  }
});

test('every row has an explicit insert, update, or skip decision and skips create no hidden cue', () => {
  const fixture = linkedProject();
  const proposal = proposalFor({ fixture });
  const result = applySermonCueReconciliation({
    project: fixture.project,
    proposal,
    decisions: decisionsFor(proposal, { skipRows: ['row-002'] }),
    confirmed: true,
    idFactory: cueIdFactory
  });

  assert.deepEqual(result.insertedItemIds, ['cue-row-001', 'cue-row-003']);
  assert.deepEqual(result.skippedRowIds, ['row-002']);
  assert.equal(result.project.items['cue-row-002'], undefined);
  assert.deepEqual(
    result.project.items['sermon-anchor'].childIds,
    ['cue-row-001', 'cue-row-003']
  );
  assert.equal(result.receipt.decisions[1].action, 'skip');
  assert.equal(result.receipt.decisions[1].itemId, null);
});

test('source-to-channel mapping is explicit and does not infer from source language or file name', () => {
  const fixture = linkedProject();
  const proposal = proposalFor({
    fixture,
    mappings: [{
      channelId: 'secondary',
      snapshot: snapshotFor(
        fixture.sermon,
        fixture.sermonRevisionId,
        'slides-ru',
        ['РУ I', 'РУ II', 'РУ III']
      )
    }]
  });

  assert.deepEqual(proposal.channelIds, ['secondary']);
  assert.equal(
    proposal.sourceOptionsByChannel.secondary.source.languages[0],
    'ru'
  );
  const result = applySermonCueReconciliation({
    project: fixture.project,
    proposal,
    decisions: decisionsFor(proposal),
    confirmed: true,
    idFactory: cueIdFactory
  });
  assert.deepEqual(
    result.project.items['cue-row-001'].textByChannel,
    { secondary: 'РУ I' }
  );
  assert.equal(result.project.items['cue-row-001'].textByChannel.primary, undefined);
  assert.equal(result.project.items['cue-row-001'].textByChannel.media, undefined);
});

test('operator can change or unpair suggestions only within each channel source pool', () => {
  const fixture = linkedProject();
  const proposal = proposalFor({ fixture });
  const secondarySecond = proposal.sourceOptionsByChannel.secondary.units[1];
  const decisions = decisionsFor(proposal, {
    overrideSelections: {
      'row-001': {
        primary: null,
        secondary: secondarySecond
      },
      'row-002': {
        secondary: proposal.sourceOptionsByChannel.secondary.units[0]
      }
    }
  });
  const result = applySermonCueReconciliation({
    project: fixture.project,
    proposal,
    decisions,
    confirmed: true,
    idFactory: cueIdFactory
  });
  assert.deepEqual(
    result.project.items['cue-row-001'].textByChannel,
    { secondary: 'EN II' }
  );

  const reused = decisionsFor(proposal, {
    overrideSelections: {
      'row-001': {
        secondary: secondarySecond
      },
      'row-002': {
        secondary: secondarySecond
      }
    }
  });
  expectCode('SOURCE_UNIT_REUSED', () => applySermonCueReconciliation({
    project: fixture.project,
    proposal,
    decisions: reused,
    confirmed: true,
    idFactory: cueIdFactory
  }));

  const foreign = decisionsFor(proposal);
  foreign[0].unitsByChannel.secondary = {
    unitId: proposal.sourceOptionsByChannel.primary.units[0].unitId,
    text: proposal.sourceOptionsByChannel.primary.units[0].text
  };
  expectCode('UNKNOWN_SOURCE_UNIT', () => applySermonCueReconciliation({
    project: fixture.project,
    proposal,
    decisions: foreign,
    confirmed: true,
    idFactory: cueIdFactory
  }));
});

test('proposal and apply fail closed on stale project, sermon, source, and snapshot bindings', () => {
  const fixture = linkedProject();
  expectCode('PROJECT_REVISION_MISMATCH', () => proposalFor({
    fixture,
    projectRevisionId: 'f'.repeat(64)
  }));
  expectCode('SERMON_BINDING_MISMATCH', () => proposalFor({
    fixture,
    sermonRevisionId: 'e'.repeat(64)
  }));

  const wrongSource = snapshotFor(
    fixture.sermon,
    fixture.sermonRevisionId,
    'slides-en',
    ['EN I', 'EN II', 'EN III']
  );
  wrongSource.binding.sourceId = 'slides-ru';
  expectCode('SNAPSHOT_BINDING_MISMATCH', () => proposalFor({
    fixture,
    mappings: [{ channelId: 'secondary', snapshot: wrongSource }]
  }));

  const badHash = snapshotFor(
    fixture.sermon,
    fixture.sermonRevisionId,
    'slides-en',
    ['EN I', 'EN II', 'EN III']
  );
  badHash.snapshotHash = 'd'.repeat(64);
  expectCode('SNAPSHOT_HASH_MISMATCH', () => proposalFor({
    fixture,
    mappings: [{ channelId: 'secondary', snapshot: badHash }]
  }));

  const proposal = proposalFor({ fixture });
  const changed = addGroupItem(fixture.project, {
    id: 'unrelated',
    title: 'Unrelated',
    groupKind: 'section',
    now: NOW
  });
  expectCode('PROJECT_REVISION_MISMATCH', () => applySermonCueReconciliation({
    project: changed,
    proposal,
    decisions: decisionsFor(proposal),
    confirmed: true,
    idFactory: cueIdFactory
  }));

  const changedProposal = clone(proposal);
  changedProposal.sourceOptionsByChannel.secondary.snapshotHash = 'e'.repeat(64);
  expectCode('INVALID_PROPOSAL', () => applySermonCueReconciliation({
    project: fixture.project,
    proposal: changedProposal,
    decisions: decisionsFor(proposal),
    confirmed: true,
    idFactory: cueIdFactory
  }));
});

test('proposal requires a complete untruncated PowerPoint Roman-outline sermon window', () => {
  const fixture = linkedProject();
  const truncated = snapshotFor(
    fixture.sermon,
    fixture.sermonRevisionId,
    'slides-en',
    ['EN I', 'EN II', 'EN III'],
    { truncated: { text: true } }
  );
  expectCode('INCOMPLETE_EXTRACTION', () => proposalFor({
    fixture,
    mappings: [{ channelId: 'secondary', snapshot: truncated }]
  }));

  const noWindow = snapshotFor(
    fixture.sermon,
    fixture.sermonRevisionId,
    'slides-en',
    ['EN I', 'EN II', 'EN III'],
    { scopeStrategy: 'pptx-no-sermon-window' }
  );
  expectCode('SERMON_WINDOW_REQUIRED', () => proposalFor({
    fixture,
    mappings: [{ channelId: 'secondary', snapshot: noWindow }]
  }));

  const missingRoman = snapshotFor(
    fixture.sermon,
    fixture.sermonRevisionId,
    'slides-en',
    ['EN I', 'EN II', 'EN III']
  );
  missingRoman.extraction.outlineSuggestions.pop();
  const missingRomanRecord = {
    schemaVersion: 1,
    kind: 'syncshow-sermon-extraction-snapshot',
    binding: missingRoman.binding,
    extraction: missingRoman.extraction
  };
  missingRoman.snapshotHash = canonicalHash(missingRomanRecord);
  expectCode('SERMON_WINDOW_REQUIRED', () => proposalFor({
    fixture,
    mappings: [{ channelId: 'secondary', snapshot: missingRoman }]
  }));
});

test('PowerPoint companions remain source-faithful while populated native sermon groups expose explicit targets', () => {
  const fixture = linkedProject();
  const companionProject = bindProjectAsPowerPointCompanion(fixture.project, {
    id: 'service-set-2026-07-28',
    fingerprint: 'd'.repeat(64),
    serviceDate: '2026-07-28',
    profileId: 'sanctuary'
  });
  expectCode('POWERPOINT_COMPANION_UNSUPPORTED', () => proposalFor({
    fixture: {
      ...fixture,
      project: companionProject
    }
  }));

  const nonempty = linkedProject({ nonempty: true });
  const proposal = proposalFor({ fixture: nonempty });
  const resolvedExisting = resolveSermonSourceLink(
    nonempty.project,
    nonempty.project.items['existing-sermon-cue']
  );
  assert.deepEqual(proposal.anchor.childIds, ['existing-sermon-cue']);
  assert.deepEqual(proposal.existingTargets, [{
    itemId: 'existing-sermon-cue',
    position: 0,
    title: 'Existing',
    presetId: 'sermon-notes',
    sectionId: null,
    effectiveSectionId: null,
    sectionOwnerId: null,
    textByChannel: { secondary: 'Existing cue' },
    fingerprint: canonicalHash({
      item: nonempty.project.items['existing-sermon-cue'],
      resolvedLink: {
        resourceId: resolvedExisting.resourceId,
        resourceOwnerId: resolvedExisting.resourceOwnerId,
        sermonRevisionId: resolvedExisting.resource.sha256,
        sectionId: null,
        sectionOwnerId: null
      }
    })
  }]);
});

test('reconciliation rejects a sermon anchor pinned to one inherited outline section', () => {
  const fixture = linkedProject();
  fixture.project = setSermonSourceLink(fixture.project, {
    itemId: 'sermon-anchor',
    sermonSectionId: 'section-i',
    now: NOW
  });
  expectCode('SECTION_PINNED_SERMON_ANCHOR', () => proposalFor({
    fixture
  }));
});

test('selected nested sermon point reconciles only its direct cues and preserves outer hierarchy', () => {
  const fixture = nestedLinkedProject();
  const rootChildrenBefore = clone(
    fixture.project.items['sermon-anchor'].childIds
  );
  const siblingPointBefore = clone(
    fixture.project.items['sermon-point-two']
  );
  const siblingCueBefore = clone(
    fixture.project.items['sibling-sermon-cue']
  );
  const nestedGroupBefore = clone(
    fixture.project.items['nested-subpoint']
  );
  const grandchildBefore = clone(
    fixture.project.items['grandchild-sermon-cue']
  );
  const proposal = proposalFor({
    fixture,
    anchorItemId: 'sermon-point-one'
  });

  assert.equal(proposal.schemaVersion, 3);
  assert.deepEqual(proposal.anchor, {
    itemId: 'sermon-point-one',
    groupKind: 'point',
    resourceId: fixture.resourceId,
    resourceOwnerId: 'sermon-anchor',
    directSectionId: 'section-i',
    effectiveSectionId: 'section-i',
    sectionOwnerId: 'sermon-point-one',
    childIds: ['nested-existing-cue', 'nested-subpoint']
  });
  assert.deepEqual(
    proposal.existingTargets.map(target => target.itemId),
    ['nested-existing-cue']
  );
  assert.deepEqual(
    {
      sectionId: proposal.existingTargets[0].sectionId,
      effectiveSectionId: proposal.existingTargets[0].effectiveSectionId,
      sectionOwnerId: proposal.existingTargets[0].sectionOwnerId
    },
    {
      sectionId: 'section-ii',
      effectiveSectionId: 'section-ii',
      sectionOwnerId: 'nested-existing-cue'
    }
  );

  const result = applySermonCueReconciliation({
    project: fixture.project,
    proposal,
    decisions: decisionsFor(proposal, {
      skipRows: ['row-003'],
      updateByRow: {
        'row-001': 'nested-existing-cue'
      },
      overrideSelections: {
        'row-001': {
          secondary: null
        }
      }
    }),
    placementIndex: 1,
    confirmed: true,
    idFactory: cueIdFactory
  });

  assert.deepEqual(
    result.project.items['sermon-anchor'].childIds,
    rootChildrenBefore
  );
  assert.deepEqual(
    result.project.items['sermon-point-one'].childIds,
    ['nested-existing-cue', 'cue-row-002', 'nested-subpoint']
  );
  assert.deepEqual(
    result.project.items['sermon-point-two'],
    siblingPointBefore
  );
  assert.deepEqual(
    result.project.items['sibling-sermon-cue'],
    siblingCueBefore
  );
  assert.deepEqual(
    result.project.items['nested-subpoint'],
    nestedGroupBefore
  );
  assert.deepEqual(
    result.project.items['grandchild-sermon-cue'],
    grandchildBefore
  );

  const updated = result.project.items['nested-existing-cue'];
  assert.equal(updated.sermonSectionId, undefined);
  assert.deepEqual(updated.titlesByChannel, {
    media: 'Preserved media title'
  });
  assert.deepEqual(updated.textByChannel, {
    primary: 'RU I',
    media: 'Preserved media text'
  });
  assert.equal(updated.operatorNotes, 'Preserve nested note');
  const inserted = result.project.items['cue-row-002'];
  assert.equal(inserted.sermonSectionId, undefined);
  assert.equal(
    resolveSermonSourceLink(result.project, updated).sectionId,
    'section-i'
  );
  assert.equal(
    resolveSermonSourceLink(result.project, inserted).sectionId,
    'section-i'
  );

  const timeline = compileServiceProject(result.project);
  const updatedCue = Object.values(timeline.cues).find(cue =>
    cue.itemId === 'nested-existing-cue');
  const insertedCue = Object.values(timeline.cues).find(cue =>
    cue.itemId === 'cue-row-002');
  assert.deepEqual(updatedCue.groupPath, ['Sermon', 'I. Foundation']);
  assert.equal(updatedCue.sourceReference.sectionId, 'section-i');
  assert.deepEqual(updatedCue.channels.primary.blocks, [{
    type: 'text',
    role: 'body',
    text: 'RU I'
  }]);
  assert.equal(insertedCue.sourceReference.sectionId, 'section-i');
  assert.deepEqual({
    schemaVersion: result.receipt.schemaVersion,
    anchorItemId: result.receipt.anchorItemId,
    anchorGroupKind: result.receipt.anchorGroupKind,
    anchorResourceId: result.receipt.anchorResourceId,
    anchorResourceOwnerId: result.receipt.anchorResourceOwnerId,
    anchorDirectSectionId: result.receipt.anchorDirectSectionId,
    anchorEffectiveSectionId: result.receipt.anchorEffectiveSectionId,
    anchorSectionOwnerId: result.receipt.anchorSectionOwnerId
  }, {
    schemaVersion: 3,
    anchorItemId: 'sermon-point-one',
    anchorGroupKind: 'point',
    anchorResourceId: fixture.resourceId,
    anchorResourceOwnerId: 'sermon-anchor',
    anchorDirectSectionId: 'section-i',
    anchorEffectiveSectionId: 'section-i',
    anchorSectionOwnerId: 'sermon-point-one'
  });
});

test('nested reconciliation rejects unlinked scopes and excludes direct cue resource overrides', () => {
  const fixture = nestedLinkedProject();
  fixture.project = addGroupItem(fixture.project, {
    id: 'unlinked-custom-group',
    title: 'Unlinked custom group',
    groupKind: 'custom',
    now: NOW
  });
  expectCode('INVALID_SERMON_ANCHOR', () => proposalFor({
    fixture,
    anchorItemId: 'unlinked-custom-group'
  }));

  fixture.project = setSermonSourceLink(fixture.project, {
    itemId: 'nested-existing-cue',
    sermonResourceId: fixture.resourceId,
    now: NOW
  });
  const proposal = proposalFor({
    fixture,
    anchorItemId: 'sermon-point-one'
  });
  assert.deepEqual(proposal.existingTargets, []);
});

test('a deeper selected subpoint keeps null as an inherited section rather than whole sermon', () => {
  const fixture = nestedLinkedProject();
  const proposal = proposalFor({
    fixture,
    anchorItemId: 'nested-subpoint'
  });
  assert.deepEqual(proposal.anchor, {
    itemId: 'nested-subpoint',
    groupKind: 'subpoint',
    resourceId: fixture.resourceId,
    resourceOwnerId: 'sermon-anchor',
    directSectionId: null,
    effectiveSectionId: 'section-i',
    sectionOwnerId: 'sermon-point-one',
    childIds: ['grandchild-sermon-cue']
  });
  assert.deepEqual(
    {
      sectionId: proposal.existingTargets[0].sectionId,
      effectiveSectionId: proposal.existingTargets[0].effectiveSectionId,
      sectionOwnerId: proposal.existingTargets[0].sectionOwnerId
    },
    {
      sectionId: null,
      effectiveSectionId: 'section-i',
      sectionOwnerId: 'sermon-point-one'
    }
  );

  const result = applySermonCueReconciliation({
    project: fixture.project,
    proposal,
    decisions: decisionsFor(proposal, {
      skipRows: ['row-002', 'row-003'],
      updateByRow: {
        'row-001': 'grandchild-sermon-cue'
      }
    }),
    placementIndex: 0,
    confirmed: true,
    idFactory: cueIdFactory
  });
  const cue = result.project.items['grandchild-sermon-cue'];
  assert.equal(cue.sermonSectionId, undefined);
  assert.equal(
    resolveSermonSourceLink(result.project, cue).sectionId,
    'section-i'
  );
});

test('populated reconciliation explicitly updates, inserts, and reorders one reviewed block without touching other children', () => {
  const fixture = linkedProject({ nonempty: true });
  fixture.project = addGroupItem(fixture.project, {
    id: 'preserved-section',
    title: 'Preserved outline group',
    groupKind: 'point',
    parentId: 'sermon-anchor',
    index: 0,
    now: NOW
  });
  fixture.project = addProjectItem(fixture.project, {
    id: 'existing-second-cue',
    kind: 'sermon',
    title: 'Second existing cue',
    textByChannel: {
      primary: 'Old second text',
      secondary: 'Old mapped English text',
      media: 'Preserved unmapped media text'
    },
    spansByChannel: {
      media: [{
        start: 0,
        end: 9,
        foreground: '#ffc000',
        weight: '700'
      }]
    },
    presetId: 'sermon-notes',
    operatorNotes: 'Keep this operator note',
    createdAt: '2026-07-27T16:00:00.000Z',
    updatedAt: '2026-07-27T16:00:00.000Z'
  }, {
    parentId: 'sermon-anchor',
    now: '2026-07-27T16:00:00.000Z'
  });
  const proposal = proposalFor({ fixture });
  assert.deepEqual(
    proposal.anchor.childIds,
    [
      'preserved-section',
      'existing-sermon-cue',
      'existing-second-cue'
    ]
  );
  assert.deepEqual(
    proposal.existingTargets.map(target => target.itemId),
    ['existing-sermon-cue', 'existing-second-cue']
  );

  const decisions = decisionsFor(proposal, {
    skipRows: ['row-003'],
    updateByRow: {
      'row-001': 'existing-second-cue'
    },
    overrideSelections: {
      'row-001': {
        secondary: null
      }
    },
    sectionByRow: {
      'row-001': 'section-i',
      'row-002': 'section-ii'
    }
  });
  const result = applySermonCueReconciliation({
    project: fixture.project,
    proposal,
    decisions,
    placementIndex: 1,
    confirmed: true,
    idFactory: cueIdFactory
  });

  assert.deepEqual(result.insertedItemIds, ['cue-row-002']);
  assert.deepEqual(result.updatedItemIds, ['existing-second-cue']);
  assert.deepEqual(result.reorderedItemIds, ['existing-second-cue']);
  assert.deepEqual(
    result.project.items['sermon-anchor'].childIds,
    [
      'preserved-section',
      'existing-second-cue',
      'cue-row-002',
      'existing-sermon-cue'
    ]
  );
  assert.equal(
    result.project.items['existing-second-cue'].textByChannel.primary,
    'RU I'
  );
  assert.equal(
    result.project.items['existing-second-cue'].textByChannel.secondary,
    undefined
  );
  assert.equal(
    result.project.items['existing-second-cue'].textByChannel.media,
    'Preserved unmapped media text'
  );
  assert.deepEqual(
    result.project.items['existing-second-cue'].spansByChannel.media,
    [{
      start: 0,
      end: 9,
      foreground: '#ffc000',
      weight: '700'
    }]
  );
  assert.equal(
    result.project.items['existing-second-cue'].operatorNotes,
    'Keep this operator note'
  );
  assert.equal(
    result.project.items['existing-second-cue'].title,
    'Second existing cue'
  );
  assert.equal(
    result.project.items['existing-second-cue'].createdAt,
    '2026-07-27T16:00:00.000Z'
  );
  assert.equal(
    result.project.items['existing-second-cue'].sermonSectionId,
    'section-i'
  );
  assert.equal(
    result.project.items['existing-sermon-cue'].textByChannel.secondary,
    'Existing cue'
  );
  assert.ok(result.project.items['preserved-section']);
  assert.equal(result.receipt.placementIndex, 1);
  assert.deepEqual(result.receipt.updatedItemIds, ['existing-second-cue']);
});

test('populated reconciliation requires explicit placement and never reuses or infers an existing target', () => {
  const fixture = linkedProject({ nonempty: true });
  const proposal = proposalFor({ fixture });
  const update = decisionsFor(proposal, {
    skipRows: ['row-002', 'row-003'],
    updateByRow: {
      'row-001': 'existing-sermon-cue'
    }
  });
  expectCode('PLACEMENT_REQUIRED', () => applySermonCueReconciliation({
    project: fixture.project,
    proposal,
    decisions: update,
    confirmed: true,
    idFactory: cueIdFactory
  }));

  const reused = decisionsFor(proposal, {
    skipRows: ['row-003'],
    updateByRow: {
      'row-001': 'existing-sermon-cue',
      'row-002': 'existing-sermon-cue'
    }
  });
  expectCode('EXISTING_TARGET_REUSED', () =>
    applySermonCueReconciliation({
      project: fixture.project,
      proposal,
      decisions: reused,
      placementIndex: 0,
      confirmed: true,
      idFactory: cueIdFactory
    }));

  const unknown = decisionsFor(proposal, {
    skipRows: ['row-002', 'row-003'],
    updateByRow: {
      'row-001': 'not-a-real-cue'
    }
  });
  expectCode('UNKNOWN_EXISTING_TARGET', () =>
    applySermonCueReconciliation({
      project: fixture.project,
      proposal,
      decisions: unknown,
      placementIndex: 0,
      confirmed: true,
      idFactory: cueIdFactory
    }));

  const skipped = decisionsFor(proposal, {
    skipRows: proposal.rows.map(row => row.id)
  });
  const unchanged = applySermonCueReconciliation({
    project: fixture.project,
    proposal,
    decisions: skipped,
    confirmed: true,
    idFactory: cueIdFactory
  });
  assert.equal(unchanged.changed, false);
  assert.equal(unchanged.receipt.placementIndex, null);
  assert.deepEqual(
    unchanged.project.items['sermon-anchor'].childIds,
    ['existing-sermon-cue']
  );
});

test('outline section pins are validated and each unmapped or unpaired channel stays hidden', () => {
  const fixture = linkedProject();
  const proposal = proposalFor({
    fixture,
    mappings: [{
      channelId: 'secondary',
      snapshot: snapshotFor(
        fixture.sermon,
        fixture.sermonRevisionId,
        'slides-en',
        ['EN I', 'EN II', 'EN III']
      )
    }]
  });
  const unknownSection = decisionsFor(proposal, {
    sectionByRow: { 'row-001': 'missing-section' }
  });
  expectCode('UNKNOWN_OUTLINE_SECTION', () => applySermonCueReconciliation({
    project: fixture.project,
    proposal,
    decisions: unknownSection,
    confirmed: true,
    idFactory: cueIdFactory
  }));

  const decisions = decisionsFor(proposal, {
    sectionByRow: { 'row-001': 'section-i' }
  });
  const result = applySermonCueReconciliation({
    project: fixture.project,
    proposal,
    decisions,
    confirmed: true,
    idFactory: cueIdFactory
  });
  const cue = compileServiceProject(result.project).cues[
    compileServiceProject(result.project).cueIds[0]
  ];
  assert.equal(cue.sourceReference.sectionId, 'section-i');
  assert.deepEqual(cue.channels.primary, { mode: 'hide', blocks: [] });
  assert.deepEqual(cue.channels.media, { mode: 'hide', blocks: [] });
});

test('strict keys, bounds, confirmation, full row coverage, and exact text are enforced', () => {
  const fixture = linkedProject();
  const proposal = proposalFor({ fixture });

  expectCode('INVALID_RECONCILIATION_REQUEST', () =>
    buildSermonCueReconciliationProposal({
      project: fixture.project,
      projectRevisionId: serviceProjectRevisionId(fixture.project),
      anchorItemId: 'sermon-anchor',
      sermonId: fixture.sermon.id,
      sermonRevisionId: fixture.sermonRevisionId,
      sourceMappings: [],
      surprise: true
    }));

  expectCode('DUPLICATE_CHANNEL_MAPPING', () => proposalFor({
    fixture,
    mappings: [{
      channelId: 'secondary',
      snapshot: snapshotFor(
        fixture.sermon,
        fixture.sermonRevisionId,
        'slides-en',
        ['EN I', 'EN II', 'EN III']
      )
    }, {
      channelId: 'secondary',
      snapshot: snapshotFor(
        fixture.sermon,
        fixture.sermonRevisionId,
        'slides-ru',
        ['RU I', 'RU II', 'RU III']
      )
    }]
  }));

  expectCode('CONFIRMATION_REQUIRED', () => applySermonCueReconciliation({
    project: fixture.project,
    proposal,
    decisions: decisionsFor(proposal),
    confirmed: false,
    idFactory: cueIdFactory
  }));

  expectCode('MISSING_ROW_DECISION', () => applySermonCueReconciliation({
    project: fixture.project,
    proposal,
    decisions: decisionsFor(proposal).slice(1),
    confirmed: true,
    idFactory: cueIdFactory
  }));

  const missingChannel = decisionsFor(proposal);
  delete missingChannel[0].unitsByChannel.primary;
  expectCode('INVALID_DECISIONS', () => applySermonCueReconciliation({
    project: fixture.project,
    proposal,
    decisions: missingChannel,
    confirmed: true,
    idFactory: cueIdFactory
  }));

  const changedText = decisionsFor(proposal);
  changedText[0].unitsByChannel.secondary.text += ' edited';
  expectCode('SOURCE_UNIT_TEXT_MISMATCH', () => applySermonCueReconciliation({
    project: fixture.project,
    proposal,
    decisions: changedText,
    confirmed: true,
    idFactory: cueIdFactory
  }));

  const extraProposalField = clone(proposal);
  extraProposalField.localPath = '/private/source.pptx';
  expectCode('INVALID_PROPOSAL', () => applySermonCueReconciliation({
    project: fixture.project,
    proposal: extraProposalField,
    decisions: decisionsFor(proposal),
    confirmed: true,
    idFactory: cueIdFactory
  }));

  const oversized = snapshotFor(
    fixture.sermon,
    fixture.sermonRevisionId,
    'slides-en',
    ['I', 'x'.repeat(MAX_PROJECT_TEXT_CHARS + 1), 'III']
  );
  expectCode('SOURCE_UNIT_TOO_LARGE', () => proposalFor({
    fixture,
    mappings: [{ channelId: 'secondary', snapshot: oversized }]
  }));
});
