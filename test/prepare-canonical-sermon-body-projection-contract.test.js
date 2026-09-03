'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const htmlSource = fs.readFileSync(
  path.join(root, 'src', 'renderer', 'index.html'),
  'utf8'
);
const controllerSource = fs.readFileSync(
  path.join(root, 'src', 'renderer', 'prepare-controller.js'),
  'utf8'
);

function plain(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function loadPreloadBridge() {
  const calls = [];
  let api = null;
  vm.runInNewContext(preloadSource, {
    require(moduleId) {
      if (moduleId !== 'electron') {
        throw new Error(`Unexpected preload dependency: ${moduleId}`);
      }
      return {
        contextBridge: {
          exposeInMainWorld(name, value) {
            if (name === 'api') api = value;
          }
        },
        ipcRenderer: {
          invoke(channel, payload) {
            calls.push({ channel, payload: plain(payload) });
            return Promise.resolve({ ok: true });
          },
          send() {},
          on() {},
          removeListener() {},
          removeAllListeners() {}
        }
      };
    },
    TextEncoder,
    console
  }, { filename: path.join(root, 'preload.js') });
  assert.ok(api);
  return { api, calls };
}

function sourceBetween(startText, endText) {
  const start = controllerSource.indexOf(startText);
  assert.notEqual(start, -1, `${startText} must exist`);
  const end = controllerSource.indexOf(endText, start + startText.length);
  assert.notEqual(end, -1, `${endText} must follow ${startText}`);
  return controllerSource.slice(start, end);
}

function handlerSource(channel) {
  const start = Math.max(
    mainSource.indexOf(`ipcMain.handle('${channel}'`),
    mainSource.indexOf(`ipcMain.handle(\n  '${channel}'`)
  );
  assert.notEqual(start, -1, `${channel} must be implemented`);
  const nextCompact = mainSource.indexOf("\nipcMain.handle('", start + 1);
  const nextExpanded = mainSource.indexOf('\nipcMain.handle(\n  ', start + 1);
  const candidates = [nextCompact, nextExpanded].filter(index => index >= 0);
  return mainSource.slice(
    start,
    candidates.length ? Math.min(...candidates) : mainSource.length
  );
}

test('main proposes exact canonical body entries and applies one recomputed project CAS', () => {
  const propose = handlerSource(
    'prepare:projects:proposeCanonicalSermonBodyProjection'
  );
  assert.match(propose, /requireControlSender\(event\)/);
  assert.match(propose, /readExpectedProject\(request\)/);
  assert.match(propose, /channelMappings\.length !== current\.project\.channelIds\.length/);
  assert.match(propose, /\['body-entry', 'hidden'\]/);
  assert.match(propose, /buildCanonicalSermonBodyProjectionProposal\(\{/);
  assert.match(propose, /holdCanonicalSermonBodyProjectionProposal\(proposal\)/);
  assert.doesNotMatch(propose, /PowerPoint|sourcePath|filePath|Community/);

  const apply = handlerSource(
    'prepare:projects:applyCanonicalSermonBodyProjection'
  );
  assert.match(apply, /requireCanonicalSermonBodyProjectionProposal/);
  assert.match(
    apply,
    /prepareCanonicalSermonBodyProjectionDecisions\([\s\S]*?request\.decisions,[\s\S]*?entry\.proposal/
  );
  assert.match(
    apply,
    /canonicalSermonBodyProjectionApplyIntentHash\(\{[\s\S]*?\.\.\.request,[\s\S]*?decisions/
  );
  assert.match(apply, /withCanonicalSermonBodyProjectionApplication/);
  assert.match(apply, /buildCanonicalSermonBodyProjectionProposal\(\{/);
  assert.match(apply, /now: entry\.proposal\.createdAt/);
  assert.match(apply, /recomputed\.id !== entry\.proposal\.id/);
  assert.match(apply, /applyCanonicalSermonBodyProjection\(\{/);
  assert.match(apply, /proposal: recomputed,[\s\S]*?decisions,/);
  assert.match(apply, /confirmed: request\.confirmed/);
  assert.match(apply, /idFactory: \(\) => projectItemId\('sermon'\)/);
  assert.match(apply, /serviceProjectStore\.save\(applied\.project/);
  assert.match(apply, /reason: 'project-canonical-sermon-body'/);
  assert.doesNotMatch(apply, /localSermonLibrary|Community|sourcePath|filePath/);
});

test('successful retry is exact-intent only and mismatched replay fails closed', () => {
  assert.match(
    mainSource,
    /function canonicalSermonBodyProjectionApplyIntentHash\(request\)[\s\S]*?decisions: request\.decisions[\s\S]*?placementIndex: request\.placementIndex[\s\S]*?confirmed: request\.confirmed/
  );
  assert.match(
    mainSource,
    /if \(entry\.completedResult\)[\s\S]*?entry\.applyIntentHash !== applyIntentHash[\s\S]*?CANONICAL_SERMON_BODY_PROJECTION_REPLAY_MISMATCH[\s\S]*?return entry\.completedResult/
  );
  assert.match(
    mainSource,
    /canonicalSermonBodyProjectionProposals\.get\(proposalToken\) === entry[\s\S]*?entry\.applying = false/
  );
});

test('preload accepts legacy rows and exposes a strict bounded treatment union', async () => {
  const { api, calls } = loadPreloadBridge();
  await api.proposeCanonicalSermonBodyProjectionForServiceItem({
    projectId: 'project-1',
    expectedRevisionId: 'a'.repeat(64),
    itemId: 'sermon-group',
    sermonId: 'sermon-1',
    sermonRevisionId: 'b'.repeat(64),
    channelMappings: [
      { channelId: 'primary', mode: 'body-entry', bodyEntryId: 'body-en' },
      { channelId: 'singer', mode: 'hidden', bodyEntryId: null }
    ]
  });
  await api.applyCanonicalSermonBodyProjectionForServiceItem({
    proposalToken: 'token',
    projectId: 'project-1',
    expectedRevisionId: 'a'.repeat(64),
    itemId: 'sermon-group',
    sermonId: 'sermon-1',
    sermonRevisionId: 'b'.repeat(64),
    decisions: {
      rows: [{
        rowId: 'body-row-001',
        action: 'insert',
        targetItemId: null,
        paragraphIdsByChannel: {
          primary: 'paragraph-001',
          singer: null
        }
      }],
      skippedParagraphIdsByChannel: {
        primary: ['paragraph-002'],
        singer: []
      }
    },
    placementIndex: 0,
    confirmed: true
  });
  const condensedText = '  Operator-authored service wording.\n';
  await api.applyCanonicalSermonBodyProjectionForServiceItem({
    proposalToken: 'token',
    projectId: 'project-1',
    expectedRevisionId: 'a'.repeat(64),
    itemId: 'sermon-group',
    sermonId: 'sermon-1',
    sermonRevisionId: 'b'.repeat(64),
    decisions: {
      rows: [{
        rowId: 'body-row-001',
        action: 'insert',
        targetItemId: null,
        treatmentsByChannel: {
          primary: {
            mode: 'condensed',
            paragraphId: 'paragraph-001',
            text: condensedText
          },
          singer: { mode: 'hidden' }
        }
      }],
      skippedParagraphIdsByChannel: {
        primary: [],
        singer: []
      }
    },
    placementIndex: 0,
    confirmed: true
  });

  assert.equal(
    calls[0].channel,
    'prepare:projects:proposeCanonicalSermonBodyProjection'
  );
  assert.deepEqual(calls[0].payload.channelMappings[1], {
    channelId: 'singer',
    mode: 'hidden',
    bodyEntryId: null
  });
  assert.equal(
    calls[1].channel,
    'prepare:projects:applyCanonicalSermonBodyProjection'
  );
  assert.deepEqual(
    calls[1].payload.decisions.skippedParagraphIdsByChannel.primary,
    ['paragraph-002']
  );
  assert.equal(calls[1].payload.confirmed, true);
  assert.deepEqual(
    calls[2].payload.decisions.rows[0].treatmentsByChannel,
    {
      primary: {
        mode: 'condensed',
        paragraphId: 'paragraph-001',
        text: condensedText
      },
      singer: { mode: 'hidden' }
    }
  );
  assert.equal(
    calls[2].payload.decisions.rows[0]
      .treatmentsByChannel.primary.text,
    condensedText
  );
  assert.throws(
    () => api.applyCanonicalSermonBodyProjectionForServiceItem({
      decisions: {
        rows: [{
          rowId: 'body-row-001',
          action: 'insert',
          treatmentsByChannel: {
            primary: {
              mode: 'condensed',
              paragraphId: 'paragraph-001',
              text: ' \n '
            },
            singer: { mode: 'hidden' }
          }
        }],
        skippedParagraphIdsByChannel: {
          primary: [],
          singer: []
        }
      }
    }),
    /Condensed text must be non-empty and bounded/
  );
  assert.throws(
    () => api.applyCanonicalSermonBodyProjectionForServiceItem({
      decisions: {
        rows: [{
          rowId: 'body-row-001',
          action: 'insert',
          treatmentsByChannel: {
            primary: {
              mode: 'exact',
              paragraphId: 'paragraph-001',
              text: 'unsupported extra'
            },
            singer: { mode: 'hidden' }
          }
        }],
        skippedParagraphIdsByChannel: {
          primary: [],
          singer: []
        }
      }
    }),
    /contains unsupported fields/
  );
  const bridge = preloadSource.slice(
    preloadSource.indexOf('// Prepare workspace'),
    preloadSource.indexOf('// App state')
  );
  assert.doesNotMatch(bridge, /sourcePath|filePath|cacheDir|packagePath/);
});

test('native dialog is separate, accessible, explicit, and PowerPoint stays disabled legacy UI', () => {
  for (const id of [
    'btnBuildNativeSermonSlides',
    'buildNativeSermonSlidesDialog',
    'buildNativeSermonSlidesTitle',
    'buildNativeSermonSlidesDescription',
    'buildNativeSermonSlidesMapping',
    'btnProposeNativeSermonSlides',
    'buildNativeSermonSlidesProposal',
    'buildNativeSermonSlidesConveniences',
    'buildNativeSermonSlidesPlacement',
    'buildNativeSermonSlidesRows',
    'buildNativeSermonSlidesConfirmed',
    'buildNativeSermonSlidesError',
    'btnCancelNativeSermonSlides',
    'btnApplyNativeSermonSlides'
  ]) {
    assert.match(htmlSource, new RegExp(`id="${id}"`));
  }
  assert.match(htmlSource, /one exact canonical sermon body entry or Hidden/);
  assert.match(
    htmlSource,
    /Exact paragraph, human-authored Condensed service text, or Hidden/
  );
  assert.match(htmlSource, /never generates condensed wording/);
  assert.match(htmlSource, /never generates condensed wording or guesses by language or position/);
  assert.match(htmlSource, /Every row and output starts Hidden/);
  assert.match(
    htmlSource,
    /Condensed text is always written or explicitly copied by the operator/
  );
  assert.match(htmlSource, /Every unused canonical paragraph is sent as an explicit Skip decision/);
  assert.match(
    htmlSource,
    /Condensed wording changes only native projected service cues/
  );
  assert.match(htmlSource, /does not edit the canonical sermon, Community, source files, or the song library/);
  assert.match(htmlSource, /Legacy: import PowerPoint slide notes/);
  assert.match(
    controllerSource,
    /const ENABLE_LEGACY_POWERPOINT_SERMON_SLIDE_IMPORT = false/
  );
  assert.match(
    controllerSource,
    /btnBuildSermonSlides\.hidden =\s*!ENABLE_LEGACY_POWERPOINT_SERMON_SLIDE_IMPORT/
  );
});

test('renderer starts neutral, offers deliberate per-channel order, and applies current confirmed evidence', () => {
  const initialize = sourceBetween(
    'function initializeNativeSermonSlidesDrafts(proposal)',
    'function renderNativeSermonSlidesPlacement(proposal)'
  );
  const review = sourceBetween(
    'function reviewNativeSermonSlidesDecisions()',
    'function renderNativeSermonSlidesStatus()'
  );
  const apply = sourceBetween(
    'async function applyNativeSermonSlides(event)',
    'function selectedSermonCueReconciliationContext()'
  );
  assert.match(initialize, /action: 'skip'/);
  assert.match(initialize, /mode: 'hidden'/);
  assert.match(initialize, /paragraphId: null/);
  assert.match(initialize, /text: ''/);
  assert.match(controllerSource, /Place \$\{mapping\.channelLabel\} in order/);
  assert.match(controllerSource, /function placeNativeSermonChannelInOrder\(channelId\)/);
  assert.match(controllerSource, /Condensed service text/);
  assert.match(controllerSource, /Start from exact paragraph/);
  assert.match(controllerSource, /Clear condensed text/);
  assert.match(controllerSource, /nativeSermonCondensedChannel/);
  assert.match(controllerSource, /treatment\.text = target\.value/);
  assert.match(
    controllerSource,
    /nativeSermonSlidesConfirmed\.checked = false;[\s\S]*?if \(renderRows\) renderNativeSermonSlidesRows/
  );
  assert.match(review, /skippedParagraphIdsByChannel/);
  assert.match(review, /!usedByChannel\.get\(mapping\.channelId\)\.has\(paragraphId\)/);
  assert.match(review, /usedTargets\.has\(draft\.targetItemId\)/);
  assert.match(review, /treatmentsByChannel/);
  assert.match(review, /treatment\.mode === 'condensed'/);
  assert.match(review, /const text = typeof treatment\.text === 'string'/);
  assert.match(review, /text\s*$/m);
  assert.match(review, /visibleCount < 1/);
  assert.match(apply, /canonicalSermonBodyProjectionProposalExpired\(proposal\)/);
  assert.match(apply, /nativeSermonSlidesContextKey\(context\)/);
  assert.match(apply, /nativeSermonSlidesConfirmed\.checked !== true/);
  assert.match(apply, /api\.applyCanonicalSermonBodyProjectionForServiceItem/);
  assert.match(apply, /decisions: review\.decisions/);
  assert.match(apply, /placementIndex: review\.placementIndex/);
  assert.match(apply, /confirmed: true/);
  assert.match(apply, /result\.bodyProjection\?\.insertedItemIds/);
  assert.match(apply, /state\.selectedItemId = firstChangedItemId/);
  assert.match(
    apply,
    /This exact confirmed review remains available; retry it without changing the decisions/
  );
  assert.match(apply, /expired\|changed after review\|stale/);
  assert.doesNotMatch(apply, /sourcePath|filePath|PowerPoint/);
});

test('main and focused renderer editor preserve non-empty projected body bytes', () => {
  const updateItem = handlerSource('prepare:projects:updateItem');
  const addText = handlerSource('prepare:projects:addText');
  const saveEditor = sourceBetween(
    'async function saveEditedItem(event)',
    'async function importSong()'
  );
  const addTextController = sourceBetween(
    'async function addText(event)',
    'function openPictureDialog()'
  );
  assert.match(
    mainSource,
    /function prepareProjectedBodyText\([\s\S]*?if \(!value\.trim\(\)\)[\s\S]*?return '';[\s\S]*?return value;/
  );
  assert.match(updateItem, /prepareProjectedBodyText\(/);
  assert.match(addText, /prepareProjectedBodyText\(/);
  assert.doesNotMatch(updateItem, /prepareText\(entry\.text/);
  assert.doesNotMatch(addText, /prepareText\(request\.text/);
  assert.match(
    saveEditor,
    /const projectedText = rawProjectedText\.trim\(\)[\s\S]*?\? rawProjectedText[\s\S]*?: ''/
  );
  assert.match(
    addTextController,
    /const text = rawText\.trim\(\) \? rawText : ''/
  );
  assert.match(
    controllerSource,
    /normalizeEditableEmphasisRanges\(rawSpans \|\| \[\], textarea\.value\)/
  );
  assert.doesNotMatch(
    controllerSource,
    /normalizeEditableEmphasisRanges\(rawSpans \|\| \[\], textarea\.value\.trim\(\)\)/
  );

  const helperStart = mainSource.indexOf(
    'function prepareProjectedBodyText('
  );
  const helperEnd = mainSource.indexOf(
    'function preparePostServiceLinkSlot(',
    helperStart
  );
  const sandbox = {
    Buffer,
    prepareProjectedBodyText: null,
    failMainOperation(code, message) {
      const error = new Error(message);
      error.code = code;
      throw error;
    }
  };
  vm.runInNewContext(
    `${mainSource.slice(helperStart, helperEnd)}
this.prepareProjectedBodyText = prepareProjectedBodyText;`,
    sandbox
  );
  const exactBytes = '  Leading text\nTrailing text  ';
  assert.equal(
    sandbox.prepareProjectedBodyText(exactBytes, 'Projected text', 20000),
    exactBytes
  );
  assert.equal(
    sandbox.prepareProjectedBodyText(' \n\t ', 'Projected text', 20000),
    ''
  );
  assert.throws(
    () => sandbox.prepareProjectedBodyText(
      ' \n\t ',
      'Projected text',
      20000,
      { required: true }
    ),
    error => error.code === 'MISSING_PREPARE_TEXT'
  );
});

test('main validates the closed treatment union before hashing and applying it', () => {
  const validator = mainSource.slice(
    mainSource.indexOf(
      'function prepareCanonicalSermonBodyProjectionDecisions(raw, proposal)'
    ),
    mainSource.indexOf('function failCanonicalSermonBodyProjection(error)')
  );
  assert.match(validator, /hasLegacy === hasTreatments/);
  assert.match(validator, /paragraphIdsByChannel/);
  assert.match(validator, /treatmentsByChannel/);
  assert.match(validator, /\['exact', 'condensed'\]/);
  assert.match(validator, /rawTreatment\.mode === 'hidden'/);
  assert.match(validator, /prepareProjectedBodyText\(/);
  assert.match(validator, /\{ required: true \}/);
  assert.match(validator, /Every reviewed canonical paragraph must be used or explicitly skipped/);
  assert.match(validator, /visibleCount < 1/);
});
