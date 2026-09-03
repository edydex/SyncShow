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
const stylesSource = fs.readFileSync(
  path.join(root, 'src', 'renderer', 'styles.css'),
  'utf8'
);
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');

function plain(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function rendererExports() {
  const window = {};
  vm.runInNewContext(
    controllerSource,
    { console, window },
    { filename: controllerPath }
  );
  return window.SyncShowPrepare;
}

function loadPreloadBridge() {
  const calls = [];
  let api = null;
  const ipcRenderer = {
    invoke(channel, payload) {
      calls.push({ channel, payload: plain(payload) });
      return Promise.resolve({ ok: true });
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
    console,
    TextEncoder
  }, { filename: path.join(root, 'preload.js') });
  assert.ok(api);
  return { api, calls };
}

function functionSource(name) {
  const marker = `function ${name}(`;
  let start = mainSource.indexOf(marker);
  assert.notEqual(start, -1, `${name} must exist`);
  if (mainSource.slice(Math.max(0, start - 6), start) === 'async ') {
    start -= 6;
  }
  const next = mainSource.indexOf('\nfunction ', start + marker.length);
  return mainSource.slice(start, next === -1 ? mainSource.length : next);
}

function handlerSource(channel) {
  const marker = `ipcMain.handle('${channel}'`;
  const start = mainSource.indexOf(marker);
  assert.notEqual(start, -1, `${channel} must exist`);
  const next = mainSource.indexOf("ipcMain.handle('", start + marker.length);
  return mainSource.slice(start, next === -1 ? mainSource.length : next);
}

function mainError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}

test('Prepare validates exact expiring canonical reference proposals', () => {
  const {
    normalizeSermonReferenceReviewProposal,
    sermonReferenceReviewProposalExpired
  } = rendererExports();
  const raw = {
    proposalToken: 'p'.repeat(32),
    expiresAt: '2026-07-28T20:15:00.000Z',
    sermon: {
      id: 'sermon-one',
      title: 'Grace upon Grace',
      baseRevisionId: 'a'.repeat(64),
      nextRevisionId: 'b'.repeat(64)
    },
    publication: {
      before: 'ready',
      after: 'draft',
      visibility: 'members',
      reset: true
    },
    changes: {
      addedReferenceIds: ['reference-new'],
      removedReferenceIds: [],
      updatedReferenceIds: ['reference-primary'],
      reordered: false
    },
    removedReferences: [],
    references: [
      {
        id: 'reference-primary',
        label: 'Ephesians 3:14-21',
        role: 'primary',
        reviewStatus: 'confirmed',
        sectionId: null,
        source: 'operator',
        enteredText: 'Ephesians 3:14-21',
        position: 0,
        previous: {
          id: 'reference-primary',
          label: 'Ephesians 3:14-21',
          role: 'primary',
          reviewStatus: 'suggested',
          sectionId: null,
          source: 'pastor',
          enteredText: 'Ephesians 3:14-21',
          position: 0
        },
        protectedByReading: true,
        preview: null,
        localPath: '/private/sermon.json'
      },
      {
        id: 'reference-new',
        label: 'Romans 8:1',
        role: 'mentioned',
        reviewStatus: 'confirmed',
        sectionId: null,
        source: 'operator',
        enteredText: 'Romans 8:1',
        position: 1,
        previous: null,
        protectedByReading: false,
        preview: {
          reference: 'Romans 8:1',
          translation: 'BSB',
          text: '1 Therefore, there is now no condemnation…',
          truncated: false
        }
      }
    ]
  };

  const proposal = normalizeSermonReferenceReviewProposal(raw);
  assert.equal(proposal.references[0].localPath, undefined);
  assert.equal(proposal.references[0].protectedByReading, true);
  assert.equal(proposal.references[1].preview.translation, 'BSB');
  assert.deepEqual(proposal.removedReferences, []);
  assert.equal(
    sermonReferenceReviewProposalExpired(
      proposal,
      Date.parse('2026-07-28T20:14:59.999Z')
    ),
    false
  );
  assert.equal(
    sermonReferenceReviewProposalExpired(
      proposal,
      Date.parse('2026-07-28T20:15:00.000Z')
    ),
    true
  );

  assert.throws(
    () => normalizeSermonReferenceReviewProposal({
      ...raw,
      references: [raw.references[0], raw.references[0]]
    }),
    /invalid reviewed Scripture reference/
  );
  assert.throws(
    () => normalizeSermonReferenceReviewProposal({
      ...raw,
      changes: {
        ...raw.changes,
        removedReferenceIds: ['reference-removed']
      }
    }),
    /incomplete change summary/
  );
});

test('Prepare reference draft snapshots contain semantic intent only', () => {
  const { sermonReferenceDraftSnapshot } = rendererExports();
  const snapshot = JSON.parse(sermonReferenceDraftSnapshot([
    {
      referenceId: 'reference-primary',
      replacementQuery: '',
      selectedBook: null,
      role: 'primary',
      confirmed: true,
      sectionId: 'outline-one',
      range: { spoofed: true },
      source: 'pastor',
      startOffset: 10,
      localPath: '/private/source.pdf'
    }
  ]));
  assert.deepEqual(snapshot, [{
    referenceId: 'reference-primary',
    replacementQuery: '',
    selectedBook: null,
    role: 'primary',
    confirmed: true,
    sectionId: 'outline-one'
  }]);
});

test('reference editor is accessible and keeps extraction separate from confirmation', () => {
  for (const id of [
    'prepareSermonReferenceSection',
    'prepareSermonReferenceStatus',
    'prepareSermonReferenceList',
    'prepareSermonReferenceReviewButton',
    'reviewSermonReferenceDialog',
    'reviewSermonReferenceDescription',
    'reviewSermonReferenceRows',
    'reviewSermonReferenceDraftQuery',
    'reviewSermonReferenceDraftPreview',
    'reviewSermonReferenceProposalRows',
    'reviewSermonReferenceFullConfirmation',
    'reviewSermonReferenceReviewSaveButton'
  ]) {
    assert.match(htmlSource, new RegExp(`id="${id}"`));
  }
  assert.match(
    htmlSource,
    /id="reviewSermonReferenceDialog"[^>]+aria-labelledby="reviewSermonReferenceTitle"[^>]+aria-describedby="reviewSermonReferenceDescription"/
  );
  assert.match(
    htmlSource,
    /Extracted citations remain suggestions until you explicitly confirm them here/
  );
  assert.match(
    htmlSource,
    /I reviewed every listed addition, change, removal, outline link, role, and order change above/
  );
  assert.ok(
    htmlSource.indexOf('id="prepareSermonReferenceSection"')
      < htmlSource.indexOf('id="prepareSermonReadingHeading"')
  );

  const openStart = controllerSource.indexOf(
    'function openSermonReferenceReview()'
  );
  const extractionStart = controllerSource.indexOf(
    'function selectedSermonExtractionContext()',
    openStart
  );
  const editorSource = controllerSource.slice(openStart, extractionStart);
  assert.match(editorSource, /previewExistingSermonReference/);
  assert.match(editorSource, /confirmationEligible/);
  assert.match(editorSource, /protectedByReading/);
  assert.match(editorSource, /firstEditableControl/);
  assert.match(editorSource, /elements\.sermonReferenceDraftQuery\)\.focus\(\)/);
  assert.match(editorSource, /api\.lookupSermonPrimaryReference/);
  assert.match(
    editorSource,
    /api\.previewSermonReferenceForServiceItem/
  );
  assert.match(editorSource, /guardSermonReferenceReviewBeforeUnload/);
  assert.match(editorSource, /Discard the unsaved Scripture-reference review changes/);
  assert.match(controllerSource, /dataset\.referenceAction/);
  assert.match(controllerSource, /removedReferences/);
  assert.match(controllerSource, /Outline:/);
  assert.match(controllerSource, /Order: position/);
  assert.match(
    controllerSource,
    /linkedSermonArchived[\s\S]+Restore this archived sermon before editing its Scripture references/
  );
  assert.match(
    controllerSource,
    /draft\.role === 'primary' && draft\.confirmed/
  );
  assert.match(
    controllerSource,
    /isBusy:[\s\S]+state\.sermonReferenceBusy[\s\S]+state\.sermonReferenceApplyBusy[\s\S]+state\.sermonReferenceLookupBusy/
  );
  assert.match(stylesSource, /\.prepare-sermon-reference-row-preview/);
  assert.match(stylesSource, /overflow:\s*auto/);
  assert.match(stylesSource, /\.prepare-sermon-reference-row-warning/);
  assert.match(
    stylesSource,
    /\.prepare-sermon-reference-row-confirmation/
  );
  assert.match(
    editorSource,
    /api\.proposeSermonReferenceReviewForServiceItem/
  );
  assert.match(
    editorSource,
    /api\.applySermonReferenceReviewForServiceItem/
  );
  assert.doesNotMatch(
    editorSource,
    /\b(?:innerHTML|outerHTML|insertAdjacentHTML)\b/
  );
});

test('preload drops renderer-owned range, provenance, and publication fields', async () => {
  const { api, calls } = loadPreloadBridge();
  await api.previewSermonReferenceForServiceItem({
    projectId: 'service-one',
    revisionId: 'a'.repeat(64),
    itemId: 'sermon-group',
    sermonId: 'sermon-one',
    sermonRevisionId: 'b'.repeat(64),
    referenceId: 'reference-primary',
    range: { spoofed: true },
    localPath: '/private/source.pdf'
  });
  await api.proposeSermonReferenceReviewForServiceItem({
    projectId: 'service-one',
    revisionId: 'a'.repeat(64),
    itemId: 'sermon-group',
    sermonId: 'sermon-one',
    sermonRevisionId: 'b'.repeat(64),
    references: [{
      referenceId: 'reference-primary',
      replacementQuery: '',
      selectedBook: null,
      role: 'primary',
      confirmed: true,
      sectionId: null,
      range: { bookId: 'Rev' },
      source: 'pastor',
      reviewStatus: 'suggested',
      startOffset: 7,
      publication: { status: 'published' },
      localPath: '/private/source.pdf'
    }]
  });
  await api.applySermonReferenceReviewForServiceItem({
    proposalToken: 'p'.repeat(32),
    confirmed: true,
    document: { spoofed: true },
    range: { spoofed: true }
  });

  assert.deepEqual(calls, [
    {
      channel: 'prepare:projects:previewSermonReference',
      payload: {
        projectId: 'service-one',
        revisionId: 'a'.repeat(64),
        itemId: 'sermon-group',
        sermonId: 'sermon-one',
        sermonRevisionId: 'b'.repeat(64),
        referenceId: 'reference-primary'
      }
    },
    {
      channel: 'prepare:projects:proposeSermonReferences',
      payload: {
        projectId: 'service-one',
        revisionId: 'a'.repeat(64),
        itemId: 'sermon-group',
        sermonId: 'sermon-one',
        sermonRevisionId: 'b'.repeat(64),
        references: [{
          referenceId: 'reference-primary',
          replacementQuery: '',
          selectedBook: null,
          role: 'primary',
          confirmed: true,
          sectionId: null
        }]
      }
    },
    {
      channel: 'prepare:projects:applySermonReferences',
      payload: {
        proposalToken: 'p'.repeat(32),
        confirmed: true
      }
    }
  ]);
});

test('main owns new identities and canonical ranges during proposal preparation', async () => {
  const context = {
    failMainOperation: mainError,
    requireExactPrepareKeys(value, keys) {
      if (Object.keys(value).some(key => !keys.includes(key))) {
        mainError('UNSUPPORTED_PREPARE_FIELDS', 'unsupported');
      }
      return value;
    },
    optionalSermonReferenceReviewId(value) {
      return value === undefined || value === null || value === ''
        ? null
        : String(value);
    },
    prepareText(value, _label, maximum, { required = false } = {}) {
      if (value === undefined || value === null) value = '';
      if (typeof value !== 'string') mainError('INVALID_TEXT', 'invalid');
      const result = value.trim();
      if (required && !result) mainError('MISSING_TEXT', 'missing');
      if (result.length > maximum) mainError('TEXT_TOO_LONG', 'long');
      return result;
    },
    resolveSermonPrimaryReferenceLookupRequest: async ({ query }) => ({
      status: 'ok',
      passage: {
        book: query.startsWith('Romans') ? 'Romans' : 'Ephesians',
        chapter: query.startsWith('Romans') ? 8 : 3,
        verseStart: query.startsWith('Romans') ? 1 : 14,
        verseEnd: query.startsWith('Romans') ? 1 : 21,
        reference: query,
        translation: { abbr: 'BSB' },
        verses: [{ number: 1, text: 'Trusted Bible data' }]
      }
    }),
    sermonReferenceBibleLibrary: {
      async lookupCanonicalRange(input) {
        context.canonicalLookupInput = input;
        return {
          status: 'ok',
          passage: {
            book: 'Ephesians',
            bookAbbr: 'Eph',
            start: { chapter: input.startChapter, verse: input.startVerse },
            end: { chapter: input.endChapter, verse: input.endVerse },
            reference: 'Ephesians 3:20–4:2',
            translation: { abbr: 'BSB' },
            verses: [
              { chapter: 3, number: 20, text: 'Trusted chapter three' },
              { chapter: 4, number: 1, text: 'Trusted chapter four' }
            ]
          }
        };
      }
    },
    resolveBookId(book) {
      return book === 'Romans' ? 'Rom' : 'Eph';
    },
    projectItemId() {
      return 'reference-main-owned';
    },
    formatBibleRange(range) {
      return `${range.bookId} ${range.start.chapter}:${range.start.verse}`;
    },
    Map,
    Set,
    Object,
    Array,
    String,
    Boolean,
    JSON
  };
  vm.runInNewContext(
    `${functionSource('prepareSermonReferenceReviewEntries')}
this.prepareEntries = prepareSermonReferenceReviewEntries;`,
    context
  );

  const sermon = {
    outline: [],
    references: [{
      id: 'reference-primary',
      range: {
        schemaVersion: 1,
        bookId: 'Eph',
        start: { chapter: 3, verse: 14 },
        end: { chapter: 3, verse: 21 }
      },
      role: 'primary',
      reviewStatus: 'confirmed',
      enteredText: 'Ephesians 3:14-21'
    }]
  };
  const prepared = await context.prepareEntries([
    {
      referenceId: 'reference-primary',
      replacementQuery: '',
      selectedBook: null,
      role: 'primary',
      confirmed: true,
      sectionId: null
    },
    {
      referenceId: null,
      replacementQuery: 'Romans 8:1',
      selectedBook: null,
      role: 'mentioned',
      confirmed: true,
      sectionId: null
    }
  ], sermon);
  assert.equal(prepared.entries[0].referenceId, 'reference-primary');
  assert.equal(prepared.entries[0].replaced, false);
  assert.equal(prepared.entries[1].referenceId, 'reference-main-owned');
  assert.deepEqual(plain(prepared.entries[1].range), {
    schemaVersion: 1,
    bookId: 'Rom',
    start: { chapter: 8, verse: 1 },
    end: { chapter: 8, verse: 1 }
  });
  assert.equal(
    prepared.previewByReferenceId.get('reference-main-owned').translation,
    'BSB'
  );

  const suggestedCrossChapter = {
    ...sermon,
    references: [{
      ...sermon.references[0],
      range: {
        schemaVersion: 1,
        bookId: 'Eph',
        start: { chapter: 3, verse: 20 },
        end: { chapter: 4, verse: 2 }
      },
      reviewStatus: 'suggested',
      enteredText: 'Ephesians 3:20-4:2'
    }]
  };
  const crossChapter = await context.prepareEntries([
    {
      referenceId: 'reference-primary',
      replacementQuery: '',
      selectedBook: null,
      role: 'primary',
      confirmed: true,
      sectionId: null
    }
  ], suggestedCrossChapter);
  assert.deepEqual(plain(context.canonicalLookupInput), {
    book: 'Eph',
    startChapter: 3,
    startVerse: 20,
    endChapter: 4,
    endVerse: 2
  });
  assert.equal(crossChapter.entries[0].replaced, false);
  assert.equal(crossChapter.entries[0].reviewStatus, 'confirmed');
  assert.match(
    crossChapter.previewByReferenceId.get('reference-primary').text,
    /3:20 Trusted chapter three 4:1 Trusted chapter four/
  );
});

test('main binds proposal tokens and commits sermon plus service as one transaction', () => {
  const preview = handlerSource('prepare:projects:previewSermonReference');
  const propose = handlerSource('prepare:projects:proposeSermonReferences');
  const apply = handlerSource('prepare:projects:applySermonReferences');

  assert.match(preview, /requireSermonReferenceTarget/);
  assert.match(preview, /lookupCanonicalRange/);
  assert.match(preview, /referenceId/);
  assert.doesNotMatch(preview, /request\.(?:range|passage|verses)\b/);
  assert.match(propose, /readExpectedProject/);
  assert.match(propose, /prepareSermonReferenceReviewEntries/);
  assert.match(propose, /applySermonReferenceReview/);
  assert.match(propose, /addSermonResource/);
  assert.match(propose, /repinSermonRevision/);
  assert.match(mainSource, /removedReferences:/);
  assert.match(mainSource, /previous:/);
  assert.match(propose, /holdSermonReferenceReviewProposal/);
  assert.match(apply, /request\.confirmed !== true/);
  assert.match(apply, /requireSermonReferenceReviewProposal/);
  assert.match(apply, /readExpectedProject/);
  assert.match(apply, /applySermonReferenceReview/);
  assert.match(apply, /repinSermonRevision/);
  assert.match(apply, /sermonProjectCommitCoordinator[\s\S]*?\.commit/);
  assert.match(apply, /expectedSermonRevision: sermonRead\.revision/);
  assert.match(apply, /reason: 'apply-sermon-reference-review'/);
  assert.doesNotMatch(
    apply,
    /request\.(?:projectId|itemId|sermonId|sermonRevisionId|references|document|range)/
  );
});
