'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { resolvePassageReference } = require('../src/services/bible');

const root = path.join(__dirname, '..');
const controllerPath = path.join(root, 'src', 'renderer', 'prepare-controller.js');
const controllerSource = fs.readFileSync(controllerPath, 'utf8');
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const htmlSource = fs.readFileSync(
  path.join(root, 'src', 'renderer', 'index.html'),
  'utf8'
);

function rendererExports() {
  const window = {};
  vm.runInNewContext(controllerSource, { console, window }, { filename: controllerPath });
  return window.SyncShowPrepare;
}

function sourceBetween(startMarker, endMarker) {
  const start = controllerSource.indexOf(startMarker);
  assert.notEqual(start, -1, `${startMarker} must exist`);
  const end = controllerSource.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `${endMarker} must follow ${startMarker}`);
  return controllerSource.slice(start, end);
}

function plain(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function loadPreloadBridge() {
  const calls = [];
  let api = null;
  const ipcRenderer = {
    invoke(channel, payload) {
      calls.push({ channel, payload: plain(payload) });
      return Promise.resolve({ success: true });
    },
    send() {},
    on() {},
    removeListener() {},
    removeAllListeners() {}
  };
  const contextBridge = {
    exposeInMainWorld(name, value) {
      if (name === 'api') api = value;
    }
  };
  vm.runInNewContext(preloadSource, {
    require(moduleId) {
      if (moduleId === 'electron') return { contextBridge, ipcRenderer };
      throw new Error(`Unexpected preload dependency: ${moduleId}`);
    },
    console
  }, { filename: path.join(root, 'preload.js') });
  assert.ok(api, 'preload must expose the renderer API');
  return { api, calls };
}

test('Prepare treats malformed and elapsed extraction expirations as unusable', () => {
  const { sermonExtractionProposalExpired } = rendererExports();
  const now = Date.parse('2026-07-27T18:00:00.000Z');

  assert.equal(sermonExtractionProposalExpired({
    expiresAt: '2026-07-27T18:00:00.001Z'
  }, now), false);
  assert.equal(sermonExtractionProposalExpired({
    expiresAt: '2026-07-27T18:00:00.000Z'
  }, now), true);
  assert.equal(sermonExtractionProposalExpired({
    expiresAt: '2026-07-27T17:59:59.999Z'
  }, now), true);
  assert.equal(sermonExtractionProposalExpired({ expiresAt: 'not-a-date' }, now), true);
});

test('Prepare strictly projects restart-safe private extraction-review evidence', () => {
  const { normalizeSavedSermonExtractionReview } = rendererExports();
  const reviewed = normalizeSavedSermonExtractionReview({
    snapshotStatus: 'reused',
    reviewStatus: 'reviewed',
    reviewedAt: '2026-07-28T12:00:00.000Z',
    outlineSelectionCount: 6,
    referenceSelectionCount: 2,
    localPath: '/private/extraction.json'
  });
  assert.deepEqual(plain(reviewed), {
    snapshotStatus: 'reused',
    reviewStatus: 'reviewed',
    reviewedAt: '2026-07-28T12:00:00.000Z',
    outlineSelectionCount: 6,
    referenceSelectionCount: 2
  });
  assert.equal(JSON.stringify(reviewed).includes('/private/'), false);

  const unreviewed = normalizeSavedSermonExtractionReview({
    snapshotStatus: 'saved',
    reviewStatus: 'unreviewed',
    reviewedAt: null,
    outlineSelectionCount: 0,
    referenceSelectionCount: 0
  });
  assert.equal(unreviewed.reviewStatus, 'unreviewed');
  assert.equal(
    normalizeSavedSermonExtractionReview(null),
    null
  );

  for (const savedReview of [
    {
      snapshotStatus: 'cached',
      reviewStatus: 'unreviewed',
      reviewedAt: null,
      outlineSelectionCount: 0,
      referenceSelectionCount: 0
    },
    {
      snapshotStatus: 'reused',
      reviewStatus: 'reviewed',
      reviewedAt: null,
      outlineSelectionCount: 1,
      referenceSelectionCount: 0
    },
    {
      snapshotStatus: 'saved',
      reviewStatus: 'unreviewed',
      reviewedAt: null,
      outlineSelectionCount: 1,
      referenceSelectionCount: 0
    },
    {
      snapshotStatus: 'reused',
      reviewStatus: 'reviewed',
      reviewedAt: '2026-07-28T05:00:00-07:00',
      outlineSelectionCount: 1,
      referenceSelectionCount: 0
    }
  ]) {
    assert.throws(
      () => normalizeSavedSermonExtractionReview(savedReview),
      /invalid saved extraction-review evidence/
    );
  }
});

test('Prepare sends only checked suggestion ids that belong to the proposal', () => {
  const { selectedSermonSuggestionIds } = rendererExports();
  const suggestions = [
    { id: 'outline-first' },
    { id: 'outline-second' },
    { id: 'outline-first' },
    { id: 'outline-third' }
  ];

  assert.deepEqual(
    JSON.parse(JSON.stringify(selectedSermonSuggestionIds(
      suggestions,
      ['unknown', 'outline-third', 'outline-first', 'outline-first']
    ))),
    ['outline-first', 'outline-third']
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(selectedSermonSuggestionIds(suggestions, []))),
    []
  );
});

test('Prepare keeps selected outline suggestions closed over proposed parents', () => {
  const { closedSermonOutlineSuggestionIds } = rendererExports();
  const suggestions = [
    { id: 'root', parentSuggestionId: '' },
    { id: 'child', parentSuggestionId: 'root' },
    { id: 'grandchild', parentSuggestionId: 'child' },
    { id: 'sibling', parentSuggestionId: 'root' },
    { id: 'independent', parentSuggestionId: '' }
  ];

  assert.deepEqual(
    JSON.parse(JSON.stringify(closedSermonOutlineSuggestionIds(
      suggestions,
      ['grandchild'],
      'grandchild',
      true
    ))),
    ['root', 'child', 'grandchild']
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(closedSermonOutlineSuggestionIds(
      suggestions,
      ['root', 'child', 'grandchild', 'sibling', 'independent'],
      'root',
      false
    ))),
    ['independent']
  );
});

test('Prepare produces bounded readable evidence and canonical-range labels', () => {
  const {
    canonicalSermonReferenceLabel,
    sermonSuggestionEvidenceText
  } = rendererExports();

  const sameChapterLabel = canonicalSermonReferenceLabel({
    schemaVersion: 1,
    bookId: 'Eph',
    start: { chapter: 3, verse: 14 },
    end: { chapter: 3, verse: 21 }
  });
  assert.equal(sameChapterLabel, 'Eph 3:14–21');
  assert.equal(
    resolvePassageReference(sameChapterLabel).status,
    'resolved'
  );
  assert.equal(
    canonicalSermonReferenceLabel({
      bookId: 'Rom',
      start: { chapter: 8, verse: null },
      end: { chapter: 8, verse: null }
    }),
    'Rom 8'
  );
  assert.equal(canonicalSermonReferenceLabel({ bookId: 'Rom' }), '');
  assert.equal(
    sermonSuggestionEvidenceText({ quote: '<img src=x onerror=alert(1)>' }),
    '<img src=x onerror=alert(1)>'
  );
  assert.equal(
    sermonSuggestionEvidenceText([{ excerpt: 'First' }, { text: 'Second' }]),
    'First · Second'
  );
});

test('Prepare extraction review is accessible, opt-in, and text-only', () => {
  for (const id of [
    'btnReviewSermonSource',
    'reviewSermonExtractionDialog',
    'reviewSermonExtractionTitle',
    'reviewSermonExtractionDescription',
    'reviewSermonExtractionSource',
    'btnProposeSermonExtraction',
    'reviewSermonExtractionStatus',
    'reviewSermonExtractionResults',
    'reviewSermonExtractionPersistence',
    'reviewSermonExtractionOutline',
    'reviewSermonExtractionReferences',
    'reviewSermonExtractionError',
    'btnCancelSermonExtraction',
    'btnApplySermonExtraction'
  ]) {
    assert.match(htmlSource, new RegExp(`id="${id}"`));
  }
  assert.match(
    htmlSource,
    /id="reviewSermonExtractionDialog"[^>]+aria-labelledby="reviewSermonExtractionTitle"[^>]+aria-describedby="reviewSermonExtractionDescription"/
  );
  assert.match(
    htmlSource,
    /Checked Scripture citations import as Needs review/
  );
  assert.match(htmlSource, /Unchecked by default\./);
  assert.match(htmlSource, /Importing does not confirm them/);

  const reviewSource = sourceBetween(
    'function appendSermonExtractionSuggestion',
    'async function loadTranslationCandidates'
  );
  assert.match(reviewSource, /checkbox\.checked = false;/);
  assert.match(reviewSource, /closedSermonOutlineSuggestionIds\(/);
  assert.match(reviewSource, /sermonExtractionPreview\.textContent =/);
  assert.match(reviewSource, /sermonExtractionSourceSummary\.textContent =/);
  assert.match(reviewSource, /Private extraction evidence was reopened/);
  assert.match(reviewSource, /not a Community upload or publication/);
  assert.match(reviewSource, /Suggestions below start unchecked/);
  assert.doesNotMatch(
    reviewSource,
    /\b(?:innerHTML|outerHTML|insertAdjacentHTML)\b/
  );
  assert.match(reviewSource, /No outline suggestions were found/);
  assert.match(reviewSource, /No Scripture-reference suggestions were found/);
  assert.match(reviewSource, /This proposal expired\./);
});

test('Prepare binds exact proposal identities and applies ids without cue text', () => {
  assert.match(
    controllerSource,
    /'proposeSermonExtractionForServiceItem'/
  );
  assert.match(
    controllerSource,
    /'applySermonExtractionForServiceItem'/
  );
  assert.match(
    controllerSource,
    /btnReviewSermonSource\.disabled =[\s\S]{0,500}sermonExtractionApplyBusy/
  );
  assert.match(
    controllerSource,
    /btnCancelSermonExtraction\.disabled = extractionLocked/
  );

  const proposeSource = sourceBetween(
    'async function proposeSermonExtraction()',
    'function updateSermonExtractionSelectionStatus'
  );
  assert.match(
    proposeSource,
    /api\.proposeSermonExtractionForServiceItem\(\{\s*projectId: context\.projectId,\s*revisionId: context\.revisionId,\s*itemId: context\.itemId,\s*sermonId: context\.sermonId,\s*sermonRevisionId: context\.sermonRevisionId,\s*sourceId\s*\}\)/
  );
  assert.match(proposeSource, /request !== state\.sermonExtractionRequest/);
  assert.match(proposeSource, /sermonExtractionContextKey\(selectedSermonExtractionContext\(\)\)/);

  const applySource = sourceBetween(
    'async function applySermonExtraction(event)',
    'async function loadTranslationCandidates'
  );
  assert.match(
    applySource,
    /api\.applySermonExtractionForServiceItem\(\{\s*proposalToken: proposal\.proposalToken,\s*projectId: context\.projectId,\s*expectedRevisionId: context\.revisionId,\s*itemId: context\.itemId,\s*sermonId: context\.sermonId,\s*expectedSermonRevisionId: context\.sermonRevisionId,\s*outlineSuggestionIds,\s*referenceSuggestionIds\s*\}\)/
  );
  const applyCallStart = applySource.indexOf(
    'api.applySermonExtractionForServiceItem({'
  );
  const applyCallEnd = applySource.indexOf('})', applyCallStart);
  const applyPayload = applySource.slice(applyCallStart, applyCallEnd);
  assert.doesNotMatch(
    applyPayload,
    /\b(?:text|title|evidence|document|cue|channel|itemPatch)\b/
  );
  assert.match(applySource, /await loadSermons\(\);/);
  assert.match(applySource, /renderAll\(\);/);
  assert.match(
    applySource,
    /projected cue wording (?:remains unchanged|was not changed)/i
  );
  assert.match(
    applySource,
    /SERMON_EXTRACTION_REVIEW_NOT_SAVED/
  );
  assert.match(
    applySource,
    /private review receipt was not saved/
  );
});

test('preload forwards only extraction identities and bounded reviewed ids', async () => {
  const { api, calls } = loadPreloadBridge();
  const outlineSuggestionIds = Array.from({ length: 502 }, (_, index) => `outline-${index}`);

  await api.proposeSermonExtractionForServiceItem({
    projectId: 'service-july-26',
    revisionId: 'a'.repeat(64),
    itemId: 'sermon-group',
    sermonId: 'sermon-prayer',
    sermonRevisionId: 'b'.repeat(64),
    sourceId: 'source-slides',
    path: '/private/sermon.pptx',
    textPreview: 'renderer supplied'
  });
  await api.applySermonExtractionForServiceItem({
    proposalToken: 'token',
    projectId: 'service-july-26',
    expectedRevisionId: 'a'.repeat(64),
    itemId: 'sermon-group',
    sermonId: 'sermon-prayer',
    expectedSermonRevisionId: 'b'.repeat(64),
    outlineSuggestionIds,
    referenceSuggestionIds: ['reference-1'],
    cueText: 'must not cross preload',
    document: { rendererOwned: true }
  });

  assert.deepEqual(calls[0], {
    channel: 'prepare:projects:proposeSermonExtraction',
    payload: {
      projectId: 'service-july-26',
      revisionId: 'a'.repeat(64),
      itemId: 'sermon-group',
      sermonId: 'sermon-prayer',
      sermonRevisionId: 'b'.repeat(64),
      sourceId: 'source-slides'
    }
  });
  assert.deepEqual(calls[1], {
    channel: 'prepare:projects:applySermonExtraction',
    payload: {
      proposalToken: 'token',
      projectId: 'service-july-26',
      expectedRevisionId: 'a'.repeat(64),
      itemId: 'sermon-group',
      sermonId: 'sermon-prayer',
      expectedSermonRevisionId: 'b'.repeat(64),
      outlineSuggestionIds: outlineSuggestionIds.slice(0, 500),
      referenceSuggestionIds: ['reference-1']
    }
  });
});

test('main keeps proposals private and coherently repins the reviewed sermon revision', () => {
  const proposeStart = mainSource.indexOf(
    "ipcMain.handle('prepare:projects:proposeSermonExtraction'"
  );
  const applyStart = mainSource.indexOf(
    "ipcMain.handle('prepare:projects:applySermonExtraction'"
  );
  const applyEnd = mainSource.indexOf(
    "ipcMain.handle('prepare:projects:createSermonPacket'",
    applyStart
  );
  assert.ok(proposeStart >= 0 && applyStart > proposeStart && applyEnd > applyStart);
  const proposeSource = mainSource.slice(proposeStart, applyStart);
  const applySource = mainSource.slice(applyStart, applyEnd);

  assert.match(proposeSource, /buildSermonExtractionReviewProposal\(\{/);
  assert.match(proposeSource, /internalProposal: built\.internalProposal/);
  assert.match(proposeSource, /snapshotHash: snapshot\.snapshotHash/);
  assert.match(proposeSource, /publicProposal: \{\s*\.\.\.built\.publicProposal,/);
  assert.match(proposeSource, /savedReview: publicSermonExtractionSavedReview\(/);
  assert.match(applySource, /applySermonExtractionReview\(/);
  assert.match(applySource, /addSermonResource\(/);
  assert.match(applySource, /repinSermonRevision\(withResource\.project,/);
  assert.match(applySource, /previousResourceId: linked\.resourceId/);
  assert.match(applySource, /nextResourceId: withResource\.resourceId/);
  assert.match(applySource, /project: repinned/);
  assert.match(applySource, /\.saveReviewReceipt\(\{/);
  assert.match(applySource, /SERMON_EXTRACTION_REVIEW_NOT_SAVED/);
  assert.doesNotMatch(applySource, /setSermonSourceLink\(/);
  assert.match(applySource, /\.\.\.projectResult\(committed\.project\)/);
  assert.doesNotMatch(
    applySource,
    /\b(?:updatePresentationItem|updateGroupItem|textByChannel|itemPatch)\b/
  );
});
