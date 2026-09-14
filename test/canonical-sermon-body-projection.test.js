'use strict';

const crypto = require('crypto');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MAX_BODY_PROJECTION_PARAGRAPHS,
  MAX_BODY_PROJECTION_TEXT_CHARS,
  CanonicalSermonBodyProjectionError,
  ServiceProjectError,
  addBibleItem,
  addGroupItem,
  addProjectItem,
  addSermonResource,
  applyCanonicalSermonBodyProjection,
  buildCanonicalSermonBodyProjectionProposal,
  compileServiceProject,
  createServiceProject,
  duplicateProjectItem,
  moveProjectItem,
  normalizeServiceProject,
  serializeServiceProject,
  serviceProjectRevisionId,
  setSermonSourceLink,
  updateTextItem
} = require('../src/services/project');

const NOW = '2026-07-30T16:00:00.000Z';
const RU_BODY = [
  '  RU first line  ',
  'RU first continuation\t',
  '',
  'RU second paragraph',
  '',
  'RU paragraph explicitly skipped'
].join('\n');
const EN_BODY = [
  'EN first paragraph',
  '',
  '  EN second paragraph  '
].join('\n');

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

function recomputeProposalId(rawProposal) {
  const proposal = clone(rawProposal);
  delete proposal.id;
  proposal.id = canonicalHash(proposal);
  return proposal;
}

function sermonDocument({
  id = 'reviewed-sermon',
  ruText = RU_BODY,
  enText = EN_BODY
} = {}) {
  return {
    schemaVersion: 3,
    kind: 'syncshow-sermon',
    id,
    titles: {
      ru: 'Проверенная проповедь',
      en: 'Reviewed sermon'
    },
    defaultLanguage: 'en',
    speaker: { id: null, name: 'Pastor Example' },
    serviceDate: '2026-07-30',
    series: null,
    outline: [],
    sources: [],
    references: [{
      id: 'primary-reading',
      range: {
        schemaVersion: 1,
        bookId: 'John',
        start: { chapter: 1, verse: 1 },
        end: { chapter: 1, verse: 1 }
      },
      role: 'primary',
      source: 'operator',
      reviewStatus: 'confirmed',
      enteredText: 'John 1:1',
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
    },
    body: [{
      id: 'reviewed-body-ru',
      kind: 'manuscript',
      language: 'ru',
      sourceId: null,
      sectionId: null,
      text: ruText
    }, {
      id: 'reviewed-body-en',
      kind: 'manuscript',
      language: 'en',
      sourceId: null,
      sectionId: null,
      text: enText
    }]
  };
}

function fixture({ existing = true, document = sermonDocument() } = {}) {
  let project = createServiceProject({
    id: 'canonical-body-service',
    title: 'Sunday Service',
    serviceDate: '2026-07-30',
    profileId: 'sanctuary',
    now: NOW,
    channels: [
      { id: 'primary', label: 'Russian', language: 'ru' },
      { id: 'secondary', label: 'English', language: 'en' },
      { id: 'media', label: 'Media', language: 'und' }
    ]
  });
  const pinned = addSermonResource(project, document);
  project = addBibleItem(pinned.project, {
    id: 'sermon-reading',
    title: 'John 1:1 (BSB)',
    range: {
      schemaVersion: 1,
      bookId: 'John',
      start: { chapter: 1, verse: 1 },
      end: { chapter: 1, verse: 1 }
    },
    passagesByChannel: {
      secondary: {
        reference: 'John 1:1',
        translationId: 'BSB',
        attribution: '',
        verses: [{
          number: 1,
          text: 'In the beginning was the Word, and the Word was with God, and the Word was God.'
        }]
      }
    },
    sermonReading: {
      sermonResourceId: pinned.resourceId,
      referenceId: 'primary-reading',
      translationId: 'BSB',
      chunkIndex: 0,
      chunkCount: 1
    },
    now: NOW
  });
  project = addProjectItem(project, {
    id: 'before-sermon',
    kind: 'notice',
    title: 'Before sermon',
    textByChannel: { primary: 'Before' },
    presetId: 'notice-text',
    operatorNotes: ''
  }, { now: NOW });
  project = addGroupItem(project, {
    id: 'sermon-anchor',
    title: 'Sermon',
    groupKind: 'sermon',
    sermonResourceId: pinned.resourceId,
    now: NOW
  });
  if (existing) {
    project = addProjectItem(project, {
      id: 'existing-sermon-cue',
      kind: 'sermon',
      title: 'Operator-authored stable title',
      titlesByChannel: {
        primary: 'Stale Russian title',
        secondary: 'Stale English title'
      },
      textByChannel: {
        primary: 'Old Russian projection',
        secondary: 'Old English projection'
      },
      spansByChannel: {
        primary: [{
          start: 0,
          end: 3,
          foreground: '#FFC000',
          weight: '700'
        }]
      },
      presetId: 'sermon-notes',
      operatorNotes: 'Preserve this operator note',
      createdAt: '2026-07-29T16:00:00.000Z',
      updatedAt: '2026-07-29T16:00:00.000Z'
    }, { parentId: 'sermon-anchor', now: NOW });
  }
  project = addProjectItem(project, {
    id: 'untouched-child',
    kind: 'notice',
    title: 'Untouched child',
    textByChannel: { primary: 'Do not change me' },
    presetId: 'notice-text',
    operatorNotes: 'Untouched'
  }, { parentId: 'sermon-anchor', now: NOW });
  project = addProjectItem(project, {
    id: 'after-sermon',
    kind: 'notice',
    title: 'After sermon',
    textByChannel: { primary: 'After' },
    presetId: 'notice-text',
    operatorNotes: ''
  }, { now: NOW });
  return {
    project,
    resourceId: pinned.resourceId,
    sermonRevisionId: pinned.resourceId.slice('sha256:'.length),
    document: project.resources[pinned.resourceId].document
  };
}

function proposalFor(current) {
  return buildCanonicalSermonBodyProjectionProposal({
    project: current.project,
    projectRevisionId: serviceProjectRevisionId(current.project),
    anchorItemId: 'sermon-anchor',
    sermonId: current.document.id,
    sermonRevisionId: current.sermonRevisionId,
    channelMappings: [{
      channelId: 'primary',
      mode: 'body-entry',
      bodyEntryId: 'reviewed-body-ru'
    }, {
      channelId: 'secondary',
      mode: 'body-entry',
      bodyEntryId: 'reviewed-body-en'
    }, {
      channelId: 'media',
      mode: 'hidden'
    }],
    now: NOW
  });
}

function reviewedDecisions({ update = false } = {}) {
  return {
    rows: [{
      rowId: 'reviewed-row-a',
      action: update ? 'update' : 'insert',
      ...(update ? { targetItemId: 'existing-sermon-cue' } : {}),
      paragraphIdsByChannel: {
        primary: 'paragraph-002',
        secondary: 'paragraph-001',
        media: null
      }
    }, {
      rowId: 'reviewed-row-b',
      action: 'insert',
      paragraphIdsByChannel: {
        primary: 'paragraph-001',
        secondary: 'paragraph-002',
        media: null
      }
    }],
    skippedParagraphIdsByChannel: {
      primary: ['paragraph-003'],
      secondary: [],
      media: []
    }
  };
}

function exactTreatmentDecisions(options = {}) {
  const decisions = reviewedDecisions(options);
  for (const row of decisions.rows) {
    const paragraphIdsByChannel = row.paragraphIdsByChannel;
    delete row.paragraphIdsByChannel;
    row.treatmentsByChannel = Object.fromEntries(
      Object.entries(paragraphIdsByChannel).map(([channelId, paragraphId]) => [
        channelId,
        paragraphId === null
          ? { mode: 'hidden' }
          : { mode: 'exact', paragraphId }
      ])
    );
  }
  return decisions;
}

function condensedTreatmentDecisions() {
  const decisions = exactTreatmentDecisions();
  decisions.rows[0].treatmentsByChannel.secondary = {
    mode: 'condensed',
    paragraphId: 'paragraph-001',
    text: '  Operator-reviewed summary\nwith preserved spacing  '
  };
  return decisions;
}

function itemIdFactory({ rowId }) {
  return `body-${rowId}`;
}

function expectProjectionCode(code, callback) {
  assert.throws(callback, error => {
    assert.ok(error instanceof CanonicalSermonBodyProjectionError);
    assert.equal(error.code, code);
    return true;
  });
}

test('proposal exposes exact per-entry paragraph pools with no multilingual alignment or trim/reflow', () => {
  const current = fixture();
  const first = proposalFor(current);
  const second = proposalFor(current);

  assert.deepEqual(first, second);
  assert.equal(Object.prototype.hasOwnProperty.call(first, 'rows'), false);
  assert.deepEqual(
    first.channelMappings.map(mapping => [
      mapping.channelId,
      mapping.mode,
      mapping.bodyEntryId
    ]),
    [
      ['primary', 'body-entry', 'reviewed-body-ru'],
      ['secondary', 'body-entry', 'reviewed-body-en'],
      ['media', 'hidden', null]
    ]
  );
  const ru = first.bodyEntries.find(entry => entry.id === 'reviewed-body-ru');
  const en = first.bodyEntries.find(entry => entry.id === 'reviewed-body-en');
  assert.deepEqual(ru.paragraphs.map(paragraph => paragraph.text), [
    '  RU first line  \nRU first continuation\t',
    'RU second paragraph',
    'RU paragraph explicitly skipped'
  ]);
  assert.deepEqual(en.paragraphs.map(paragraph => paragraph.text), [
    'EN first paragraph',
    '  EN second paragraph  '
  ]);
  for (const entry of first.bodyEntries) {
    const source = current.document.body.find(body => body.id === entry.id).text;
    for (const paragraph of entry.paragraphs) {
      assert.equal(paragraph.defaultAction, 'skip');
      assert.equal(
        source.slice(paragraph.startOffset, paragraph.endOffset),
        paragraph.text
      );
      assert.equal(
        crypto.createHash('sha256').update(paragraph.text).digest('hex'),
        paragraph.textSha256
      );
    }
  }
});

test('one reviewed mutation updates/inserts exact rows, clears stale formatting, and preserves unrelated service evidence', () => {
  const current = fixture();
  const proposal = proposalFor(current);
  const before = {
    resource: canonicalJson(current.project.resources[current.resourceId]),
    reading: canonicalJson(current.project.items['sermon-reading']),
    untouched: canonicalJson(current.project.items['untouched-child']),
    rootItemIds: [...current.project.rootItemIds]
  };
  const result = applyCanonicalSermonBodyProjection({
    project: current.project,
    proposal,
    decisions: reviewedDecisions({ update: true }),
    confirmed: true,
    idFactory: itemIdFactory,
    placementIndex: 1
  });

  assert.equal(result.changed, true);
  assert.deepEqual(result.updatedItemIds, ['existing-sermon-cue']);
  assert.deepEqual(result.insertedItemIds, ['body-reviewed-row-b']);
  assert.deepEqual(result.project.items['sermon-anchor'].childIds, [
    'existing-sermon-cue',
    'body-reviewed-row-b',
    'untouched-child'
  ]);
  const updated = result.project.items['existing-sermon-cue'];
  assert.equal(updated.title, 'Operator-authored stable title');
  assert.equal(updated.operatorNotes, 'Preserve this operator note');
  assert.equal(updated.createdAt, '2026-07-29T16:00:00.000Z');
  assert.equal(updated.titlesByChannel, undefined);
  assert.equal(updated.spansByChannel, undefined);
  assert.deepEqual(updated.textByChannel, {
    primary: 'RU second paragraph',
    secondary: 'EN first paragraph'
  });
  assert.deepEqual(result.project.items['body-reviewed-row-b'].textByChannel, {
    primary: '  RU first line  \nRU first continuation\t',
    secondary: '  EN second paragraph  '
  });
  assert.equal(
    result.project.items['body-reviewed-row-b'].sourceBodyProjection.proposalId,
    proposal.id
  );
  assert.equal(
    result.project.items['body-reviewed-row-b']
      .sourceBodyProjection.channels.primary.paragraphId,
    'paragraph-001'
  );
  assert.equal(
    canonicalJson(result.project.resources[current.resourceId]),
    before.resource
  );
  assert.equal(canonicalJson(result.project.items['sermon-reading']), before.reading);
  assert.equal(canonicalJson(result.project.items['untouched-child']), before.untouched);
  assert.deepEqual(result.project.rootItemIds, before.rootItemIds);

  const roundTrip = normalizeServiceProject(
    JSON.parse(serializeServiceProject(result.project))
  );
  assert.deepEqual(
    roundTrip.items['existing-sermon-cue'].sourceBodyProjection,
    updated.sourceBodyProjection
  );
  const compiled = compileServiceProject(roundTrip);
  assert.equal(
    compiled.cueIds
      .map(cueId => compiled.cues[cueId])
      .filter(cue => ['existing-sermon-cue', 'body-reviewed-row-b']
        .includes(cue.itemId))
      .length,
    2
  );
});

test('explicit exact treatments preserve legacy project bytes and schema-v1 receipts', () => {
  const current = fixture({ existing: false });
  const proposal = proposalFor(current);
  const apply = decisions => applyCanonicalSermonBodyProjection({
    project: current.project,
    proposal,
    decisions,
    confirmed: true,
    idFactory: itemIdFactory,
    placementIndex: 0
  }).project;
  const legacy = apply(reviewedDecisions());
  const explicit = apply(exactTreatmentDecisions());

  assert.equal(
    serializeServiceProject(explicit),
    serializeServiceProject(legacy)
  );
  for (const itemId of ['body-reviewed-row-a', 'body-reviewed-row-b']) {
    assert.equal(explicit.items[itemId].sourceBodyProjection.schemaVersion, 1);
    assert.equal(
      Object.prototype.hasOwnProperty.call(
        explicit.items[itemId].sourceBodyProjection.channels.primary,
        'mode'
      ),
      false
    );
  }
});

test('condensed treatments remain operator-authored, source-bound, and explicit in compiled output', () => {
  const current = fixture({ existing: false });
  const proposal = proposalFor(current);
  const result = applyCanonicalSermonBodyProjection({
    project: current.project,
    proposal,
    decisions: condensedTreatmentDecisions(),
    confirmed: true,
    idFactory: itemIdFactory,
    placementIndex: 0
  });
  const condensedId = 'body-reviewed-row-a';
  const exactId = 'body-reviewed-row-b';
  const condensed = result.project.items[condensedId];
  const receipt = condensed.sourceBodyProjection;
  const reviewedSummary =
    '  Operator-reviewed summary\nwith preserved spacing  ';

  assert.deepEqual(condensed.textByChannel, {
    primary: 'RU second paragraph',
    secondary: reviewedSummary
  });
  assert.equal(receipt.schemaVersion, 2);
  assert.equal(receipt.channels.primary.mode, 'exact');
  assert.equal(receipt.channels.secondary.mode, 'condensed');
  assert.equal(receipt.channels.secondary.paragraphId, 'paragraph-001');
  assert.equal(
    receipt.channels.secondary.sourceTextSha256,
    crypto.createHash('sha256').update('EN first paragraph').digest('hex')
  );
  assert.equal(
    receipt.channels.secondary.projectedTextSha256,
    crypto.createHash('sha256').update(reviewedSummary).digest('hex')
  );
  assert.equal(
    result.project.items[exactId].sourceBodyProjection.schemaVersion,
    1
  );

  const roundTrip = normalizeServiceProject(
    JSON.parse(serializeServiceProject(result.project))
  );
  assert.deepEqual(
    roundTrip.items[condensedId].sourceBodyProjection,
    receipt
  );
  const compiled = compileServiceProject(roundTrip);
  const cue = Object.values(compiled.cues).find(candidate =>
    candidate.itemId === condensedId);
  assert.ok(cue);
  assert.equal(cue.channels.primary.mode, 'content');
  assert.equal(cue.channels.secondary.mode, 'condensed');
  assert.equal(
    cue.channels.secondary.blocks.find(block => block.role === 'body').text,
    reviewedSummary
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      cue.channels.secondary,
      'sourceChannelId'
    ),
    false
  );
  assert.deepEqual(cue.channels.media, { mode: 'hide', blocks: [] });

  const exactChannelEdited = updateTextItem(result.project, {
    itemId: condensedId,
    textByChannel: {
      ...condensed.textByChannel,
      primary: 'Operator replaced the exact-language output'
    },
    now: '2026-07-30T16:01:00.000Z'
  });
  assert.deepEqual(
    Object.keys(
      exactChannelEdited.items[condensedId].sourceBodyProjection.channels
    ),
    ['secondary']
  );
  assert.equal(
    exactChannelEdited.items[condensedId]
      .sourceBodyProjection.channels.secondary.mode,
    'condensed'
  );
  const editedCompiled = compileServiceProject(exactChannelEdited);
  const editedCue = Object.values(editedCompiled.cues).find(candidate =>
    candidate.itemId === condensedId);
  assert.equal(editedCue.channels.primary.mode, 'content');
  assert.equal(editedCue.channels.secondary.mode, 'condensed');

  const textTamper = JSON.parse(serializeServiceProject(result.project));
  textTamper.items[condensedId].textByChannel.secondary =
    'Unreviewed replacement';
  assert.throws(() => normalizeServiceProject(textTamper), error => {
    assert.ok(error instanceof ServiceProjectError);
    assert.equal(error.code, 'SOURCE_BODY_PROJECTION_TEXT_MISMATCH');
    return true;
  });

  const sourceTamper = JSON.parse(serializeServiceProject(result.project));
  sourceTamper.items[condensedId]
    .sourceBodyProjection.channels.secondary.sourceTextSha256 = '0'.repeat(64);
  assert.throws(() => normalizeServiceProject(sourceTamper), error => {
    assert.ok(error instanceof ServiceProjectError);
    assert.equal(error.code, 'SOURCE_BODY_PROJECTION_TEXT_MISMATCH');
    return true;
  });

  const paragraphIdTamper = JSON.parse(serializeServiceProject(result.project));
  paragraphIdTamper.items[condensedId]
    .sourceBodyProjection.channels.secondary.paragraphId =
      'forged-paragraph';
  assert.throws(() => normalizeServiceProject(paragraphIdTamper), error => {
    assert.ok(error instanceof ServiceProjectError);
    assert.equal(error.code, 'SOURCE_BODY_PROJECTION_TEXT_MISMATCH');
    return true;
  });

  const paragraphBoundaryTamper =
    JSON.parse(serializeServiceProject(result.project));
  const secondParagraph = '  EN second paragraph  ';
  const secondStart = EN_BODY.indexOf(secondParagraph);
  const secondEnd = secondStart + secondParagraph.length;
  const tamperedSource = paragraphBoundaryTamper.items[condensedId]
    .sourceBodyProjection.channels.secondary;
  tamperedSource.startOffset = secondStart;
  tamperedSource.endOffset = secondEnd;
  tamperedSource.sourceTextSha256 = crypto.createHash('sha256')
    .update(secondParagraph)
    .digest('hex');
  assert.throws(
    () => normalizeServiceProject(paragraphBoundaryTamper),
    error => {
      assert.ok(error instanceof ServiceProjectError);
      assert.equal(error.code, 'SOURCE_BODY_PROJECTION_TEXT_MISMATCH');
      return true;
    }
  );
});

test('a row may project only human-authored condensed text while every other output is Hidden', () => {
  const current = fixture({ existing: false });
  const proposal = proposalFor(current);
  const decisions = condensedTreatmentDecisions();
  decisions.rows[0].treatmentsByChannel.primary = { mode: 'hidden' };
  decisions.skippedParagraphIdsByChannel.primary.push('paragraph-002');
  const result = applyCanonicalSermonBodyProjection({
    project: current.project,
    proposal,
    decisions,
    confirmed: true,
    idFactory: itemIdFactory,
    placementIndex: 0
  });
  const projected = result.project.items['body-reviewed-row-a'];
  assert.deepEqual(projected.textByChannel, {
    secondary: '  Operator-reviewed summary\nwith preserved spacing  '
  });
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      projected.sourceBodyProjection.channels,
      'primary'
    ),
    false
  );
  assert.equal(
    projected.sourceBodyProjection.channels.secondary.mode,
    'condensed'
  );
});

test('apply requires explicit accounting for every mapped paragraph and output', () => {
  const current = fixture({ existing: false });
  const proposal = proposalFor(current);
  const apply = decisions => applyCanonicalSermonBodyProjection({
    project: current.project,
    proposal,
    decisions,
    confirmed: true,
    idFactory: itemIdFactory,
    placementIndex: 0
  });

  const missingOutput = reviewedDecisions();
  delete missingOutput.rows[0].paragraphIdsByChannel.media;
  expectProjectionCode('MISSING_PARAGRAPH_DECISION', () => apply(missingOutput));

  const missingParagraph = reviewedDecisions();
  missingParagraph.skippedParagraphIdsByChannel.primary = [];
  expectProjectionCode('MISSING_PARAGRAPH_DECISION', () => apply(missingParagraph));

  const reused = reviewedDecisions();
  reused.skippedParagraphIdsByChannel.secondary = ['paragraph-001'];
  expectProjectionCode('PARAGRAPH_REUSED', () => apply(reused));

  const hiddenSelection = reviewedDecisions();
  hiddenSelection.rows[0].paragraphIdsByChannel.media = 'paragraph-001';
  expectProjectionCode('HIDDEN_CHANNEL_SELECTED', () => apply(hiddenSelection));

  const wrongEntry = reviewedDecisions();
  wrongEntry.rows[0].paragraphIdsByChannel.primary = 'paragraph-004';
  expectProjectionCode('UNKNOWN_PARAGRAPH', () => apply(wrongEntry));

  const bothShapes = exactTreatmentDecisions();
  bothShapes.rows[0].paragraphIdsByChannel = {
    primary: 'paragraph-002',
    secondary: 'paragraph-001',
    media: null
  };
  expectProjectionCode('INVALID_DECISIONS', () => apply(bothShapes));

  const reusedByCondensed = condensedTreatmentDecisions();
  reusedByCondensed.rows[1].treatmentsByChannel.secondary.paragraphId =
    'paragraph-001';
  expectProjectionCode('PARAGRAPH_REUSED', () => apply(reusedByCondensed));

  const inferredCondensed = condensedTreatmentDecisions();
  delete inferredCondensed.rows[0].treatmentsByChannel.secondary.text;
  expectProjectionCode('INVALID_DECISIONS', () => apply(inferredCondensed));

  const blankCondensed = condensedTreatmentDecisions();
  blankCondensed.rows[0].treatmentsByChannel.secondary.text = ' \n\t ';
  expectProjectionCode('INVALID_DECISIONS', () => apply(blankCondensed));

  const oversizedCondensed = condensedTreatmentDecisions();
  oversizedCondensed.rows[0].treatmentsByChannel.secondary.text =
    'x'.repeat(MAX_BODY_PROJECTION_TEXT_CHARS + 1);
  expectProjectionCode('INVALID_DECISIONS', () => apply(oversizedCondensed));
});

test('tamper, stale project state, changed binding, and replay all fail closed', () => {
  const current = fixture({ existing: false });
  const proposal = proposalFor(current);
  const tampered = clone(proposal);
  tampered.bodyEntries[0].paragraphs[0].text = 'Attacker replacement';
  tampered.bodyEntries[0].paragraphs[0].textSha256 = crypto
    .createHash('sha256')
    .update(tampered.bodyEntries[0].paragraphs[0].text)
    .digest('hex');
  const rehashedTamper = recomputeProposalId(tampered);
  expectProjectionCode('PROPOSAL_BINDING_MISMATCH', () =>
    applyCanonicalSermonBodyProjection({
      project: current.project,
      proposal: rehashedTamper,
      decisions: reviewedDecisions(),
      confirmed: true,
      idFactory: itemIdFactory,
      placementIndex: 0
    }));

  const stale = addProjectItem(current.project, {
    id: 'late-change',
    kind: 'notice',
    title: 'Late change',
    textByChannel: { primary: 'Changed after review' },
    presetId: 'notice-text',
    operatorNotes: ''
  }, { now: '2026-07-30T16:01:00.000Z' });
  expectProjectionCode('PROJECT_REVISION_MISMATCH', () =>
    applyCanonicalSermonBodyProjection({
      project: stale,
      proposal,
      decisions: reviewedDecisions(),
      confirmed: true,
      idFactory: itemIdFactory,
      placementIndex: 0
    }));

  const rebound = recomputeProposalId({
    ...clone(proposal),
    anchor: {
      ...clone(proposal.anchor),
      parent: {
        ...clone(proposal.anchor.parent),
        childIds: [...proposal.anchor.parent.childIds].reverse()
      }
    }
  });
  expectProjectionCode('PROPOSAL_BINDING_MISMATCH', () =>
    applyCanonicalSermonBodyProjection({
      project: current.project,
      proposal: rebound,
      decisions: reviewedDecisions(),
      confirmed: true,
      idFactory: itemIdFactory,
      placementIndex: 0
    }));

  const applied = applyCanonicalSermonBodyProjection({
    project: current.project,
    proposal,
    decisions: reviewedDecisions(),
    confirmed: true,
    idFactory: itemIdFactory,
    placementIndex: 0
  });
  expectProjectionCode('PROJECT_REVISION_MISMATCH', () =>
    applyCanonicalSermonBodyProjection({
      project: applied.project,
      proposal,
      decisions: reviewedDecisions(),
      confirmed: true,
      idFactory: itemIdFactory,
      placementIndex: 0
    }));
});

test('all-skipped review is unchanged, but still requires confirmation and exact skip evidence', () => {
  const current = fixture({ existing: false });
  const proposal = proposalFor(current);
  const allSkipped = {
    rows: [],
    skippedParagraphIdsByChannel: {
      primary: ['paragraph-001', 'paragraph-002', 'paragraph-003'],
      secondary: ['paragraph-001', 'paragraph-002'],
      media: []
    }
  };
  const result = applyCanonicalSermonBodyProjection({
    project: current.project,
    proposal,
    decisions: allSkipped,
    confirmed: true,
    idFactory: itemIdFactory
  });
  assert.equal(result.changed, false);
  assert.equal(
    serializeServiceProject(result.project),
    serializeServiceProject(current.project)
  );
  expectProjectionCode('CONFIRMATION_REQUIRED', () =>
    applyCanonicalSermonBodyProjection({
      project: current.project,
      proposal,
      decisions: allSkipped,
      confirmed: false,
      idFactory: itemIdFactory
    }));
});

test('placement and existing-target bindings are explicit for populated groups', () => {
  const current = fixture();
  const proposal = proposalFor(current);
  expectProjectionCode('PLACEMENT_REQUIRED', () =>
    applyCanonicalSermonBodyProjection({
      project: current.project,
      proposal,
      decisions: reviewedDecisions({ update: true }),
      confirmed: true,
      idFactory: itemIdFactory
    }));

  const unknownTarget = reviewedDecisions({ update: true });
  unknownTarget.rows[0].targetItemId = 'untouched-child';
  expectProjectionCode('UNKNOWN_EXISTING_TARGET', () =>
    applyCanonicalSermonBodyProjection({
      project: current.project,
      proposal,
      decisions: unknownTarget,
      confirmed: true,
      idFactory: itemIdFactory,
      placementIndex: 0
    }));
});

test('bounded paragraph extraction rejects oversized paragraphs and excessive pools', () => {
  const oversized = fixture({
    existing: false,
    document: sermonDocument({
      ruText: 'x'.repeat(MAX_BODY_PROJECTION_TEXT_CHARS + 1)
    })
  });
  expectProjectionCode('BODY_PARAGRAPH_TOO_LARGE', () => proposalFor(oversized));

  const excessive = fixture({
    existing: false,
    document: sermonDocument({
      ruText: Array.from(
        { length: MAX_BODY_PROJECTION_PARAGRAPHS + 1 },
        (_, index) => `Paragraph ${index + 1}`
      ).join('\n\n')
    })
  });
  expectProjectionCode('BODY_ENTRY_PARAGRAPH_LIMIT', () => proposalFor(excessive));
});

test('text edits retain only byte-identical reviewed channels and upgrade legacy evidence to v2', () => {
  const current = fixture({ existing: false });
  const proposal = proposalFor(current);
  const applied = applyCanonicalSermonBodyProjection({
    project: current.project,
    proposal,
    decisions: reviewedDecisions(),
    confirmed: true,
    idFactory: itemIdFactory,
    placementIndex: 0
  }).project;
  const projectedId = 'body-reviewed-row-a';
  const rawTamper = JSON.parse(serializeServiceProject(applied));
  rawTamper.items[projectedId].textByChannel.primary = 'Silent edit';
  assert.throws(() => normalizeServiceProject(rawTamper), error => {
    assert.ok(error instanceof ServiceProjectError);
    assert.equal(error.code, 'SOURCE_BODY_PROJECTION_TEXT_MISMATCH');
    return true;
  });

  const originalReceipt = JSON.stringify(
    applied.items[projectedId].sourceBodyProjection
  );
  const titleOnly = updateTextItem(applied, {
    itemId: projectedId,
    title: 'Operator label only',
    now: '2026-07-30T16:02:00.000Z'
  });
  assert.equal(
    JSON.stringify(titleOnly.items[projectedId].sourceBodyProjection),
    originalReceipt
  );
  const reorderedButUnchanged = updateTextItem(titleOnly, {
    itemId: projectedId,
    textByChannel: {
      secondary: titleOnly.items[projectedId].textByChannel.secondary,
      primary: titleOnly.items[projectedId].textByChannel.primary
    },
    now: '2026-07-30T16:02:30.000Z'
  });
  assert.equal(
    JSON.stringify(
      reorderedButUnchanged.items[projectedId].sourceBodyProjection
    ),
    originalReceipt
  );
  const textEdited = updateTextItem(titleOnly, {
    itemId: projectedId,
    textByChannel: {
      ...titleOnly.items[projectedId].textByChannel,
      primary: 'Operator intentionally replaced exact canonical text'
    },
    now: '2026-07-30T16:03:00.000Z'
  });
  const retained = textEdited.items[projectedId].sourceBodyProjection;
  assert.equal(retained.schemaVersion, 2);
  assert.deepEqual(Object.keys(retained.channels), ['secondary']);
  assert.equal(retained.channels.secondary.mode, 'exact');
  assert.equal(
    retained.channels.secondary.sourceTextSha256,
    retained.channels.secondary.projectedTextSha256
  );
  const compiledEdited = compileServiceProject(textEdited);
  const editedCue = Object.values(compiledEdited.cues).find(candidate =>
    candidate.itemId === projectedId);
  assert.equal(editedCue.channels.primary.mode, 'content');
  assert.equal(editedCue.channels.secondary.mode, 'content');

  const allEvidenceEdited = updateTextItem(textEdited, {
    itemId: projectedId,
    textByChannel: {
      ...textEdited.items[projectedId].textByChannel,
      secondary: 'Operator intentionally replaced the remaining exact text'
    },
    now: '2026-07-30T16:03:30.000Z'
  });
  assert.equal(
    allEvidenceEdited.items[projectedId].sourceBodyProjection,
    undefined
  );

  const duplicated = duplicateProjectItem(applied, {
    itemId: projectedId,
    randomUUID: () => '11111111-1111-4111-8111-111111111111',
    now: '2026-07-30T16:04:00.000Z'
  });
  const copiedId = duplicated.items['sermon-11111111-1111-4111-8111-111111111111']
    ? 'sermon-11111111-1111-4111-8111-111111111111'
    : Object.keys(duplicated.items).find(itemId =>
      itemId !== projectedId
      && duplicated.items[itemId].kind === 'sermon'
      && duplicated.items[itemId].title.includes('(copy)'));
  assert.ok(copiedId);
  assert.equal(duplicated.items[copiedId].sourceBodyProjection, undefined);

  const moved = moveProjectItem(applied, {
    itemId: projectedId,
    targetParentId: null,
    now: '2026-07-30T16:05:00.000Z'
  });
  assert.equal(moved.items[projectedId].sourceBodyProjection, undefined);
});

test('changing an ancestor sermon binding clears descendant projection receipts', () => {
  const current = fixture({ existing: false });
  const applied = applyCanonicalSermonBodyProjection({
    project: current.project,
    proposal: proposalFor(current),
    decisions: reviewedDecisions(),
    confirmed: true,
    idFactory: itemIdFactory,
    placementIndex: 0
  }).project;
  const second = addSermonResource(
    applied,
    sermonDocument({ id: 'second-sermon' })
  );
  const relinked = setSermonSourceLink(second.project, {
    itemId: 'sermon-anchor',
    sermonResourceId: second.resourceId,
    now: '2026-07-30T16:06:00.000Z'
  });
  assert.equal(
    relinked.items['body-reviewed-row-a'].sourceBodyProjection,
    undefined
  );
  assert.equal(
    relinked.items['body-reviewed-row-b'].sourceBodyProjection,
    undefined
  );
});
