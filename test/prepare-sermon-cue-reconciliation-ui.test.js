'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const controllerPath = path.join(
  root,
  'src',
  'renderer',
  'prepare-controller.js'
);
const controllerSource = fs.readFileSync(controllerPath, 'utf8');
const htmlSource = fs.readFileSync(
  path.join(root, 'src', 'renderer', 'index.html'),
  'utf8'
);
const cssSource = fs.readFileSync(
  path.join(root, 'src', 'renderer', 'styles.css'),
  'utf8'
);

function rendererExports() {
  const window = {};
  vm.runInNewContext(
    controllerSource,
    { console, URL, window },
    { filename: controllerPath }
  );
  return window.SyncShowPrepare;
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function sourceBetween(startMarker, endMarker) {
  const start = controllerSource.indexOf(startMarker);
  assert.notEqual(start, -1, `${startMarker} must exist`);
  const end = controllerSource.indexOf(
    endMarker,
    start + startMarker.length
  );
  assert.notEqual(end, -1, `${endMarker} must follow ${startMarker}`);
  return controllerSource.slice(start, end);
}

function unit(id, ordinal, label, text) {
  return { unitId: id, ordinal, label, text };
}

function sourcePool({
  channelId,
  channelLabel,
  channelLanguage,
  sourceId,
  fileName,
  sourceLanguage,
  sourceRevision,
  snapshotHash,
  units
}) {
  return {
    channelId,
    channelLabel,
    channelLanguage,
    source: {
      id: sourceId,
      kind: 'slide-notes',
      fileName,
      mediaType:
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      sha256: sourceRevision,
      languages: [sourceLanguage]
    },
    snapshotHash,
    extractor: {
      id: 'pptx-slide-notes',
      version: 1
    },
    window: {
      startUnitId: units[0].unitId,
      endUnitId: units[units.length - 1].unitId,
      startOrdinal: units[0].ordinal,
      endOrdinal: units[units.length - 1].ordinal,
      unitCount: units.length
    },
    units
  };
}

function proposalPayload(overrides = {}) {
  const primaryUnits = [
    unit('primary-i', 3, 'I. Foundation', 'Exact primary point one.'),
    unit('primary-ii', 4, 'II. Content', 'Exact primary point two.')
  ];
  const secondaryUnits = [
    unit('secondary-i', 5, 'I. Основание', 'Точный второй текст.')
  ];
  const primary = sourcePool({
    channelId: 'primary',
    channelLabel: 'English',
    channelLanguage: 'en',
    sourceId: 'slides-en',
    fileName: 'sermon-en.pptx',
    sourceLanguage: 'en',
    sourceRevision: 'a'.repeat(64),
    snapshotHash: 'b'.repeat(64),
    units: primaryUnits
  });
  const secondary = sourcePool({
    channelId: 'secondary',
    channelLabel: 'Russian',
    channelLanguage: 'ru',
    sourceId: 'slides-ru',
    fileName: 'sermon-ru.pptx',
    sourceLanguage: 'ru',
    sourceRevision: 'c'.repeat(64),
    snapshotHash: 'd'.repeat(64),
    units: secondaryUnits
  });
  return {
    proposalToken: 'A'.repeat(32),
    expiresAt: '2026-07-29T12:15:00.000Z',
    proposal: {
      schemaVersion: 3,
      kind: 'syncshow-sermon-cue-reconciliation-proposal',
      createdAt: '2026-07-29T12:00:00.000Z',
      project: {
        id: 'service-one',
        revisionId: 'e'.repeat(64),
        revision: 7,
        updatedAt: '2026-07-29T11:55:00.000Z',
        planningStatus: 'planning'
      },
      anchor: {
        itemId: 'sermon-group',
        groupKind: 'sermon',
        resourceId: `sha256:${'f'.repeat(64)}`,
        resourceOwnerId: 'sermon-group',
        directSectionId: null,
        effectiveSectionId: null,
        sectionOwnerId: null,
        childIds: []
      },
      sermon: {
        id: 'sermon-one',
        revisionId: 'f'.repeat(64)
      },
      channelIds: ['primary', 'secondary'],
      unmappedChannelIds: ['media'],
      existingTargets: [],
      sourceOptionsByChannel: {
        primary,
        secondary
      },
      rows: [{
        id: 'row-001',
        ordinal: 1,
        relativePosition: { slot: 1, slotCount: 2 },
        suggested: true,
        suggestionsByChannel: {
          primary: {
            unitId: primaryUnits[0].unitId,
            label: primaryUnits[0].label,
            text: primaryUnits[0].text,
            suggested: true
          },
          secondary: {
            unitId: secondaryUnits[0].unitId,
            label: secondaryUnits[0].label,
            text: secondaryUnits[0].text,
            suggested: true
          }
        },
        unmatchedChannelIds: []
      }, {
        id: 'row-002',
        ordinal: 2,
        relativePosition: { slot: 2, slotCount: 2 },
        suggested: true,
        suggestionsByChannel: {
          primary: {
            unitId: primaryUnits[1].unitId,
            label: primaryUnits[1].label,
            text: primaryUnits[1].text,
            suggested: true
          },
          secondary: null
        },
        unmatchedChannelIds: ['secondary']
      }],
      id: '1'.repeat(64)
    },
    ...overrides
  };
}

test('Prepare strictly projects bounded exact-bound sermon cue proposals', () => {
  const {
    normalizeSermonCueReconciliationProposal
  } = rendererExports();
  const payload = proposalPayload();
  const projected = normalizeSermonCueReconciliationProposal(payload, {
    projectId: 'service-one',
    revisionId: 'e'.repeat(64),
    itemId: 'sermon-group',
    groupKind: 'sermon',
    resourceId: `sha256:${'f'.repeat(64)}`,
    resourceOwnerId: 'sermon-group',
    directSectionId: null,
    effectiveSectionId: null,
    sectionOwnerId: null,
    sermonId: 'sermon-one',
    sermonRevisionId: 'f'.repeat(64),
    channelIds: ['primary', 'secondary', 'media']
  });

  assert.deepEqual(plain(projected), payload);
  assert.equal(
    projected.proposal.rows[1].suggestionsByChannel.secondary,
    null
  );
  assert.equal(
    projected.proposal.sourceOptionsByChannel.primary.units[0].text,
    'Exact primary point one.'
  );
  assert.equal(
    Object.hasOwn(
      projected.proposal.sourceOptionsByChannel.primary.source,
      'path'
    ),
    false
  );

  const payloadWithSpans = proposalPayload();
  payloadWithSpans.proposal.sourceOptionsByChannel.primary.units[0].spans = [{
    start: 0,
    end: 5,
    foreground: '#ffc000',
    weight: '700'
  }];
  const projectedWithSpans = normalizeSermonCueReconciliationProposal(
    payloadWithSpans
  );
  assert.deepEqual(
    plain(
      projectedWithSpans.proposal.sourceOptionsByChannel.primary.units[0].spans
    ),
    [{
      start: 0,
      end: 5,
      foreground: '#ffc000',
      weight: '700'
    }]
  );
  assert.equal(
    Object.hasOwn(
      projectedWithSpans.proposal.rows[0].suggestionsByChannel.primary,
      'spans'
    ),
    false
  );

  assert.throws(
    () => normalizeSermonCueReconciliationProposal({
      ...payload,
      sourcePath: '/private/sermon-en.pptx'
    }),
    /unsupported sermon-slide review proposal details/
  );
  assert.throws(
    () => normalizeSermonCueReconciliationProposal({
      ...payload,
      proposal: {
        ...payload.proposal,
        sourceOptionsByChannel: {
          ...payload.proposal.sourceOptionsByChannel,
          primary: {
            ...payload.proposal.sourceOptionsByChannel.primary,
            source: {
              ...payload.proposal.sourceOptionsByChannel.primary.source,
              fileName: '/Users/operator/sermon-en.pptx'
            }
          }
        }
      }
    }),
    /local path/
  );
  assert.throws(
    () => normalizeSermonCueReconciliationProposal(payload, {
      projectId: 'another-service'
    }),
    /different exact service or sermon/
  );
  const invalidSpans = proposalPayload();
  invalidSpans.proposal.sourceOptionsByChannel.primary.units[0].spans = [{
    start: 0,
    end: 5,
    foreground: '#ffffff'
  }];
  assert.throws(
    () => normalizeSermonCueReconciliationProposal(invalidSpans),
    /invalid trusted sermon-slide text spans/
  );
});

test('Prepare preserves direct versus inherited section state for a nested anchor', () => {
  const {
    normalizeSermonCueReconciliationProposal
  } = rendererExports();
  const payload = proposalPayload();
  payload.proposal.anchor = {
    itemId: 'sermon-point-one',
    groupKind: 'point',
    resourceId: `sha256:${'f'.repeat(64)}`,
    resourceOwnerId: 'sermon-group',
    directSectionId: null,
    effectiveSectionId: 'section-i',
    sectionOwnerId: 'sermon-section-one',
    childIds: ['existing-cue']
  };
  payload.proposal.existingTargets = [{
    itemId: 'existing-cue',
    position: 0,
    title: 'Existing cue',
    presetId: 'sermon-notes',
    sectionId: null,
    effectiveSectionId: 'section-i',
    sectionOwnerId: 'sermon-section-one',
    textByChannel: { primary: 'Existing exact text' },
    fingerprint: '2'.repeat(64)
  }];

  const projected = normalizeSermonCueReconciliationProposal(payload, {
    itemId: 'sermon-point-one',
    groupKind: 'point',
    resourceOwnerId: 'sermon-group',
    directSectionId: null,
    effectiveSectionId: 'section-i',
    sectionOwnerId: 'sermon-section-one'
  });
  assert.deepEqual(plain(projected.proposal.anchor), payload.proposal.anchor);
  assert.deepEqual(
    plain(projected.proposal.existingTargets[0]),
    payload.proposal.existingTargets[0]
  );

  const inconsistent = proposalPayload();
  inconsistent.proposal.anchor = {
    ...payload.proposal.anchor
  };
  inconsistent.proposal.existingTargets = [{
    ...payload.proposal.existingTargets[0],
    effectiveSectionId: null,
    sectionOwnerId: null
  }];
  assert.throws(
    () => normalizeSermonCueReconciliationProposal(inconsistent),
    /inconsistent existing sermon-slide section details/
  );
});

test('Prepare treats malformed and elapsed sermon cue proposals as expired', () => {
  const { sermonCueReconciliationProposalExpired } = rendererExports();
  const now = Date.parse('2026-07-29T12:00:00.000Z');

  assert.equal(sermonCueReconciliationProposalExpired({
    expiresAt: '2026-07-29T12:00:00.001Z'
  }, now), false);
  assert.equal(sermonCueReconciliationProposalExpired({
    expiresAt: '2026-07-29T12:00:00.000Z'
  }, now), true);
  assert.equal(sermonCueReconciliationProposalExpired({
    expiresAt: '2026-07-29T11:59:59.999Z'
  }, now), true);
  assert.equal(sermonCueReconciliationProposalExpired({
    expiresAt: 'not-a-date'
  }, now), true);
});

test('Prepare derives nested eligibility, inherited copy, bulk scope, and placement from exact selected-group state', () => {
  const {
    sermonCueCanUseAllSuggested,
    sermonCueInheritedSectionOptionLabel,
    sermonCuePlacementOptions,
    sermonCueReconciliationSelection
  } = rendererExports();
  const sermonResource = {
    kind: 'sermon',
    sha256: 'f'.repeat(64),
    document: {
      kind: 'syncshow-sermon',
      id: 'sermon-nested-ui',
      titles: { en: 'Nested UI sermon' },
      defaultLanguage: 'en'
    }
  };
  const project = {
    workflowMode: 'native',
    rootItemIds: ['sermon-owner'],
    resources: {
      'sermon-resource': sermonResource,
      'foreign-resource': {
        ...sermonResource,
        sha256: 'e'.repeat(64),
        document: {
          ...sermonResource.document,
          id: 'sermon-foreign'
        }
      }
    },
    items: {
      'sermon-owner': {
        id: 'sermon-owner',
        kind: 'group',
        groupKind: 'sermon',
        childIds: ['sermon-point'],
        sermonResourceId: 'sermon-resource',
        sermonSectionId: null
      },
      'sermon-point': {
        id: 'sermon-point',
        kind: 'group',
        groupKind: 'point',
        childIds: ['cue-a', 'nested-subpoint'],
        sermonSectionId: 'section-i'
      },
      'cue-a': {
        id: 'cue-a',
        kind: 'nativeCue',
        title: 'First cue'
      },
      'nested-subpoint': {
        id: 'nested-subpoint',
        kind: 'group',
        groupKind: 'subpoint',
        title: 'Nested subpoint',
        childIds: []
      }
    }
  };

  const point = sermonCueReconciliationSelection(project, 'sermon-point');
  assert.equal(point.item.groupKind, 'point');
  assert.equal(point.linked.resourceOwnerId, 'sermon-owner');
  assert.equal(point.linked.sectionId, 'section-i');

  project.items['sermon-point'].groupKind = 'section';
  assert.equal(
    sermonCueReconciliationSelection(project, 'sermon-point').item.groupKind,
    'section'
  );
  project.items['sermon-point'].groupKind = 'point';

  project.items['sermon-point'].sermonResourceId = 'foreign-resource';
  assert.equal(
    sermonCueReconciliationSelection(project, 'sermon-point'),
    null
  );
  delete project.items['sermon-point'].sermonResourceId;

  assert.equal(
    sermonCueInheritedSectionOptionLabel({
      effectiveSectionId: 'section-i',
      effectiveSectionTitle: 'I. Count the cost'
    }),
    'Inherit “I. Count the cost” from the selected group'
  );
  assert.equal(
    sermonCueInheritedSectionOptionLabel({ effectiveSectionId: null }),
    'Whole sermon / no direct section pin'
  );

  const emptyProposal = {
    proposal: {
      anchor: { childIds: [] }
    }
  };
  assert.equal(
    sermonCueCanUseAllSuggested(
      { isWholeSermonAnchor: false },
      emptyProposal
    ),
    false
  );
  assert.equal(
    sermonCueCanUseAllSuggested(
      { isWholeSermonAnchor: true },
      emptyProposal
    ),
    true
  );

  assert.deepEqual(plain(sermonCuePlacementOptions(
    ['cue-a', 'nested-subpoint'],
    [
      { itemId: 'cue-a', title: 'First cue' },
      { itemId: 'nested-subpoint', title: 'Nested subpoint' },
      { itemId: 'outside-sibling', title: 'Outside sibling' }
    ]
  )), [
    { value: '0', label: 'Before “First cue”' },
    {
      value: '1',
      label: 'Between “First cue” and “Nested subpoint”'
    },
    { value: '2', label: 'After “Nested subpoint”' }
  ]);
});

test('sermon slide reconciliation has an accessible explicit review dialog', () => {
  for (const id of [
    'btnBuildSermonSlides',
    'buildSermonSlidesDialog',
    'buildSermonSlidesTitle',
    'buildSermonSlidesDescription',
    'buildSermonSlidesMapping',
    'buildSermonSlidesMappingStatus',
    'btnProposeSermonCueReconciliation',
    'buildSermonSlidesProposal',
    'buildSermonSlidesProposalSummary',
    'btnUseAllSuggestedSermonRows',
    'buildSermonSlidesPlacementField',
    'buildSermonSlidesPlacement',
    'buildSermonSlidesRows',
    'buildSermonSlidesConfirmed',
    'buildSermonSlidesError',
    'btnCancelBuildSermonSlides',
    'btnApplySermonCueReconciliation'
  ]) {
    assert.match(htmlSource, new RegExp(`id="${id}"`));
  }
  assert.match(
    htmlSource,
    /id="buildSermonSlidesDialog"[^>]+aria-labelledby="buildSermonSlidesTitle"[^>]+aria-describedby="buildSermonSlidesDescription"/
  );
  assert.match(htmlSource, /Existing cues are never selected or changed automatically/);
  assert.match(htmlSource, /File names and languages are hints only/);
  assert.match(htmlSource, /Every row defaults to Skip/);
  assert.match(htmlSource, /Update requires choosing one eligible existing direct sermon cue/);
  assert.match(htmlSource, /preserves that cue’s title, preset, operator notes, creation time/);
  assert.match(
    htmlSource,
    /Choosing the target starts from its current direct outline override/
  );
  assert.match(
    htmlSource,
    /blank override inherits the selected group’s effective section/
  );
  assert.match(htmlSource, /stale mapped output titles are cleared/);
  assert.match(
    htmlSource,
    /Nested groups and every untouched child keep their identity, content, hierarchy, and relative order/
  );
  assert.match(htmlSource, /Use all suggested rows/);
  assert.match(htmlSource, /Exact source text is read-only here/);
  assert.match(htmlSource, /reviewed every row, target, block placement, output pairing, exact text/);
  const dialog = htmlSource.slice(
    htmlSource.indexOf('id="buildSermonSlidesDialog"'),
    htmlSource.indexOf('id="newServiceProjectDialog"')
  );
  assert.doesNotMatch(dialog, /<textarea|contenteditable/);
  assert.doesNotMatch(dialog, /sourcePath|filePath|bytes/i);
  assert.match(cssSource, /\.prepare-sermon-cue-rows[\s\S]*?overflow: auto/);
  assert.match(cssSource, /\.prepare-sermon-cue-exact-text[\s\S]*?white-space: pre-wrap/);
  assert.match(cssSource, /@media \(max-width: 760px\)[\s\S]*?\.prepare-sermon-cue-row-controls/);
});

test('Prepare proposes from blank explicit output mappings and exact bindings', () => {
  const selection = sourceBetween(
    'function sermonCueReconciliationSelection(project, itemId)',
    'function sermonCueInheritedSectionOptionLabel(context)'
  );
  const context = sourceBetween(
    'function selectedSermonCueReconciliationContext()',
    'function sermonCueContextKey(context)'
  );
  const mappings = sourceBetween(
    'function renderSermonCueMappings(context)',
    'function selectedSermonCueMappings()'
  );
  const propose = sourceBetween(
    'async function proposeSermonCueReconciliation()',
    'function changeSermonCueDecision(event)'
  );

  assert.match(selection, /isPowerPointCompanionProject\(project\)/);
  assert.match(selection, /item\?\.kind !== 'group'/);
  assert.match(
    selection,
    /SERMON_RECONCILIATION_GROUP_KINDS\.includes\(item\.groupKind\)/
  );
  assert.doesNotMatch(selection, /item\.groupKind !== 'sermon'/);
  assert.match(
    controllerSource,
    /Place this group under a whole-sermon group linked to an exact sermon revision first\./
  );
  assert.doesNotMatch(selection, /item\.childIds\.length > 0/);
  assert.match(
    context,
    /sermonCueReconciliationSelection\(\s*state\.currentProject,\s*row\?\.item\?\.id\s*\)/
  );
  assert.match(context, /childIds: \[\.\.\.item\.childIds\]/);
  assert.match(context, /existingChildren: item\.childIds\.map/);
  assert.match(selection, /resourceOwner\.groupKind !== 'sermon'/);
  assert.match(
    selection,
    /resourceOwner\.sermonResourceId !== linked\.resourceId/
  );
  assert.match(selection, /resourceOwner\.sermonSectionId/);
  assert.match(context, /resourceOwnerId: linked\.resourceOwnerId/);
  assert.match(context, /effectiveSectionId: linked\.sectionId \|\| null/);
  assert.match(context, /source\?\.kind === 'slide-notes'/);
  assert.match(mappings, /select\.value = ''/);
  assert.match(mappings, /Do not map this output/);
  assert.match(
    propose,
    /api\.proposeSermonCueReconciliationForServiceItem\(\{\s*projectId: context\.projectId,\s*expectedRevisionId: context\.revisionId,\s*itemId: context\.itemId,\s*sermonId: context\.sermonId,\s*sermonRevisionId: context\.sermonRevisionId,\s*sourceMappings\s*\}\)/
  );
  assert.match(
    propose,
    /sermonCueContextKey\(context\)[\s\S]*sermonCueContextKey\(selectedSermonCueReconciliationContext\(\)\)/
  );
  assert.doesNotMatch(propose, /sourcePath|filePath|bytes/);
});

test('Prepare defaults every row to Skip and requires explicit populated-tree targets and placement', () => {
  const drafts = sourceBetween(
    'function initializeSermonCueDrafts(proposal)',
    'function selectedSermonCueUnit'
  );
  const renderer = sourceBetween(
    'function renderSermonCueRows()',
    'function reviewSermonCueDecisions()'
  );
  const review = sourceBetween(
    'function reviewSermonCueDecisions()',
    'function renderSermonCueReviewStatus()'
  );
  const useAll = sourceBetween(
    'function useAllSuggestedSermonCueRows()',
    'async function applySermonCueReconciliation(event)'
  );

  assert.match(drafts, /action: 'skip'/);
  assert.match(renderer, /appendOption\(action, 'skip', 'Skip'\)/);
  assert.match(renderer, /appendOption\(action, 'insert', 'Insert'\)/);
  assert.match(renderer, /appendOption\(action, 'update', 'Update existing cue'\)/);
  assert.match(renderer, /Choose an existing cue/);
  assert.match(renderer, /Current target before update/);
  assert.match(controllerSource, /Current title/);
  assert.match(controllerSource, /Current outline pin/);
  assert.match(controllerSource, /Inherits .* from the selected group/);
  assert.match(
    renderer,
    /sermonCueInheritedSectionOptionLabel\(context\)/
  );
  assert.match(renderer, /Unpair — keep this output hidden/);
  assert.match(renderer, /Suggested match missing/);
  assert.match(renderer, /prepare-sermon-cue-exact-text/);
  assert.match(
    sourceBetween(
      'function updateSermonCueExactText',
      'function renderSermonCueRows()'
    ),
    /exact\.textContent =/
  );
  assert.doesNotMatch(renderer, /textarea|contentEditable|innerHTML/);
  assert.match(review, /action: 'skip'/);
  assert.match(review, /targetItemId: null/);
  assert.match(review, /EXISTING|existingTargets/);
  assert.match(review, /usedTargetIds/);
  assert.match(review, /placementIndex/);
  assert.match(review, /\[channelId, null\]/);
  assert.match(review, /unitId: unit\.unitId,\s*text: unit\.text/);
  assert.doesNotMatch(review, /spans:\s*unit\.spans/);
  assert.match(review, /source unit .* is paired more than once/);
  assert.match(useAll, /draft\.action = 'insert'/);
  assert.match(
    useAll,
    /sermonCueCanUseAllSuggested\(\s*state\.sermonCueContext,\s*state\.sermonCueProposal\s*\)/
  );
  assert.match(useAll, /sermonCueConfirmed\.checked = false/);
  assert.match(
    controllerSource,
    /existingTarget\?\.sectionId \|\| null[\s\S]*?sectionSelect\.value = draft\.sectionId \|\| ''/
  );
});

test('Prepare applies only confirmed current decisions and selects the first changed cue', () => {
  const apply = sourceBetween(
    'async function applySermonCueReconciliation(event)',
    'async function loadTranslationCandidates'
  );
  assert.match(apply, /sermonCueReconciliationProposalExpired\(proposal\)/);
  assert.match(
    apply,
    /sermonCueContextKey\(context\) !== sermonCueContextKey\(current\)/
  );
  assert.match(apply, /elements\.sermonCueConfirmed\.checked !== true/);
  assert.match(apply, /const review = reviewSermonCueDecisions\(\)/);
  assert.match(apply, /await mutateProject\(/);
  assert.match(
    apply,
    /api\.applySermonCueReconciliationForServiceItem\(\{\s*proposalToken: proposal\.proposalToken,\s*projectId: context\.projectId,\s*expectedRevisionId: context\.revisionId,\s*itemId: context\.itemId,\s*sermonId: context\.sermonId,\s*sermonRevisionId: context\.sermonRevisionId,\s*decisions: review\.decisions,\s*placementIndex: review\.placementIndex,\s*confirmed: true\s*\}\)/
  );
  assert.match(apply, /result\.reconciliation\?\.insertedItemIds/);
  assert.match(apply, /result\.reconciliation\?\.updatedItemIds/);
  assert.match(apply, /state\.selectedItemId = firstChangedItemId/);
  assert.match(apply, /await loadProjects\(\)/);
  assert.match(apply, /resetSermonCueReview\(\)/);
  assert.doesNotMatch(apply, /sourcePath|filePath|bytes|snapshotHash/);
});
