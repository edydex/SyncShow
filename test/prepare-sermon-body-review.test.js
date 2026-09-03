'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const controllerPath = path.join(root, 'src', 'renderer', 'prepare-controller.js');
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
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function sourceBetween(startMarker, endMarker) {
  const start = controllerSource.indexOf(startMarker);
  assert.notEqual(start, -1, `${startMarker} must exist`);
  const end = controllerSource.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `${endMarker} must follow ${startMarker}`);
  return controllerSource.slice(start, end);
}

function bodyProposal(overrides = {}) {
  return {
    proposalToken: 'A'.repeat(32),
    expiresAt: '2026-07-29T12:00:00.000Z',
    sermon: {
      id: 'sermon-one',
      title: 'Prayer and the Church',
      defaultLanguage: 'en',
      publicationStatus: 'ready',
      visibility: 'members'
    },
    source: {
      id: 'pastor-manuscript',
      fileName: 'sermon-notes.pdf',
      kind: 'manuscript',
      languages: ['en', 'ru']
    },
    entry: {
      id: 'pastor-manuscript',
      kind: 'manuscript',
      language: 'mul',
      text: 'Complete English text.\n\nПолный русский текст.'
    },
    bodyEntryCount: 1,
    replacesExisting: false,
    ...overrides
  };
}

function conflictCopy(body) {
  return {
    revision: 'a'.repeat(64),
    title: 'Reviewed sermon',
    titles: { en: 'Reviewed sermon' },
    defaultLanguage: 'en',
    speaker: { name: 'Pastor One' },
    serviceDate: '2026-07-27',
    series: null,
    outline: [],
    body: body.map(entry => ({
      metadataFingerprint: 'AAAA-BBBB-CCCC',
      ...entry
    })),
    references: [],
    publication: {
      status: 'draft',
      visibility: 'private',
      publishedAt: null,
      canonicalLink: null
    },
    sourceCount: 1,
    mediaCount: 0,
    media: {
      total: 0,
      shown: 0,
      truncated: false,
      setFingerprint: '1111-2222-3333',
      items: []
    }
  };
}

test('Prepare strictly projects exact complete sermon-body proposals', () => {
  const {
    normalizeSermonBodyProposal,
    reviewedSermonBodyEntry,
    sermonBodyUtf8Bytes
  } = rendererExports();
  const projected = normalizeSermonBodyProposal(bodyProposal(), {
    sermonId: 'sermon-one',
    sourceId: 'pastor-manuscript'
  });

  assert.deepEqual(plain(projected), bodyProposal());
  assert.equal(projected.entry.text.includes('Полный'), true);
  assert.equal(Object.hasOwn(projected.source, 'path'), false);
  assert.equal(
    sermonBodyUtf8Bytes('é'),
    2
  );
  assert.deepEqual(
    plain(reviewedSermonBodyEntry(projected, 'RU', 'Reviewed\r\ntext')),
    {
      id: 'pastor-manuscript',
      kind: 'manuscript',
      language: 'ru',
      text: 'Reviewed\ntext'
    }
  );

  assert.throws(
    () => normalizeSermonBodyProposal({
      ...bodyProposal(),
      localPath: '/private/sermon-notes.pdf'
    }),
    /unsupported sermon-text review proposal details/
  );
  assert.throws(
    () => normalizeSermonBodyProposal(bodyProposal({
      proposalToken: 'short'
    })),
    /invalid sermon-text review token/
  );
  assert.throws(
    () => normalizeSermonBodyProposal(bodyProposal({
      expiresAt: '2026-07-29T05:00:00-07:00'
    })),
    /invalid sermon-text review token/
  );
  assert.throws(
    () => normalizeSermonBodyProposal(bodyProposal({
      source: {
        ...bodyProposal().source,
        fileName: '/Users/operator/sermon-notes.pdf'
      }
    })),
    /local path/
  );
  assert.throws(
    () => normalizeSermonBodyProposal(bodyProposal(), {
      sermonId: 'another-sermon',
      sourceId: 'pastor-manuscript'
    }),
    /different exact source/
  );
  assert.throws(
    () => normalizeSermonBodyProposal(bodyProposal({
      entry: {
        ...bodyProposal().entry,
        text: 'é'.repeat((1024 * 1024 / 2) + 1)
      }
    })),
    /invalid sermon body-entry text/
  );
  assert.throws(
    () => reviewedSermonBodyEntry(projected, 'en', 'Before\uD800after'),
    /unsupported characters/
  );
});

test('Prepare treats malformed and elapsed sermon-body proposals as expired', () => {
  const { sermonBodyProposalExpired } = rendererExports();
  const now = Date.parse('2026-07-29T12:00:00.000Z');

  assert.equal(sermonBodyProposalExpired({
    expiresAt: '2026-07-29T12:00:00.001Z'
  }, now), false);
  assert.equal(sermonBodyProposalExpired({
    expiresAt: '2026-07-29T12:00:00.000Z'
  }, now), true);
  assert.equal(sermonBodyProposalExpired({
    expiresAt: '2026-07-29T11:59:59.999Z'
  }, now), true);
  assert.equal(sermonBodyProposalExpired({ expiresAt: 'not-a-date' }, now), true);
});

test('reviewed sermon text has its own accessible explicit-confirmation dialog', () => {
  for (const id of [
    'btnReviewSermonBody',
    'reviewSermonBodyDialog',
    'reviewSermonBodyTitle',
    'reviewSermonBodyDescription',
    'reviewSermonBodySource',
    'btnProposeSermonBody',
    'reviewSermonBodyStatus',
    'reviewSermonBodyResults',
    'reviewSermonBodySermonSummary',
    'reviewSermonBodySourceSummary',
    'reviewSermonBodyPublicationNotice',
    'reviewSermonBodyLanguage',
    'reviewSermonBodyText',
    'reviewSermonBodyTextMeta',
    'reviewSermonBodyFieldError',
    'reviewSermonBodyConfirmed',
    'reviewSermonBodyError',
    'btnCancelSermonBody',
    'btnApplySermonBody'
  ]) {
    assert.match(htmlSource, new RegExp(`id="${id}"`));
  }
  assert.match(
    htmlSource,
    /id="reviewSermonBodyDialog"[^>]+aria-labelledby="reviewSermonBodyTitle"[^>]+aria-describedby="reviewSermonBodyDescription"/
  );
  assert.match(htmlSource, /Load complete text/);
  assert.match(htmlSource, /I reviewed this complete text and its language/);
  assert.match(htmlSource, /not just a preview/);
  assert.match(htmlSource, /Use mul when one body entry contains multiple languages/);
  assert.match(
    htmlSource,
    /id="reviewSermonBodyTextMeta" role="status" aria-live="polite"/
  );
  assert.match(
    htmlSource,
    /id="reviewSermonBodyFieldError"[^>]+role="alert"/
  );
  assert.match(
    htmlSource,
    /id="reviewSermonBodyLanguage"[^>]+aria-describedby="reviewSermonBodyLanguageHelp reviewSermonBodyFieldError"/
  );

  const actions = htmlSource.slice(
    htmlSource.indexOf('id="btnAttachSermonSource"'),
    htmlSource.indexOf('id="prepareSermonSourceStatus"')
  );
  assert.match(actions, /id="btnReviewSermonSource"/);
  assert.match(actions, /id="btnReviewSermonBody"/);
});

test('Prepare loads complete text with exact native or companion identities and never a preview', () => {
  const open = sourceBetween(
    'function openSermonBodyDialog()',
    'function closeSermonBodyDialog()'
  );
  const propose = sourceBetween(
    'async function proposeSermonBody()',
    'function updateSermonBodyDraft(event)'
  );
  const eligibility = sourceBetween(
    'function eligibleSermonBodySources(context)',
    'function updateSermonBodyTextMeta()'
  );
  const controls = sourceBetween(
    'const eligibleBodySources = linkedSources.filter',
    'const song = row?.item?.kind'
  );

  assert.match(open, /selectedSermonExtractionContext\(\)/);
  assert.match(open, /selectedOption\?\.dataset\.sermonId !== context\.sermonId/);
  assert.match(eligibility, /\['manuscript', 'transcript'\]/);
  assert.doesNotMatch(open, /companionProject/);
  assert.doesNotMatch(controls, /\|\| companionProject/);
  assert.match(
    propose,
    /api\.proposeSermonBodyForServiceItem\(\{\s*projectId: context\.projectId,\s*revisionId: context\.revisionId,\s*itemId: context\.itemId,\s*sermonId: context\.sermonId,\s*sermonRevisionId: context\.sermonRevisionId,\s*sourceId\s*\}\)/
  );
  assert.match(
    propose,
    /sermonExtractionContextKey\(context\)[\s\S]*sermonExtractionContextKey\(selectedSermonExtractionContext\(\)\)/
  );
  assert.match(propose, /sermonBodyText\.value = proposal\.entry\.text/);
  assert.doesNotMatch(propose, /textPreview|previewText/);
});

test('Prepare saves only confirmed bounded entry edits with stale and expiry guards', () => {
  const apply = sourceBetween(
    'async function applySermonBody(event)',
    'async function loadTranslationCandidates'
  );
  assert.match(apply, /sermonBodyProposalExpired\(proposal\)/);
  assert.match(
    apply,
    /sermonExtractionContextKey\(context\) !== sermonExtractionContextKey\(currentContext\)/
  );
  assert.match(apply, /sermonBodyConfirmed\.checked !== true/);
  assert.match(apply, /reviewedSermonBodyEntry\(/);
  assert.match(
    apply,
    /api\.applySermonBodyForServiceItem\(\{\s*proposalToken: proposal\.proposalToken,\s*projectId: context\.projectId,\s*expectedRevisionId: context\.revisionId,\s*itemId: context\.itemId,\s*sermonId: context\.sermonId,\s*expectedSermonRevisionId: context\.sermonRevisionId,\s*entry,\s*confirmed: true\s*\}\)/
  );
  assert.match(apply, /await loadSermons\(\);/);
  assert.match(apply, /await loadSelectedSermonCommunityState\(\{ force: true \}\);/);
  assert.match(apply, /Projected cues were not changed/);
  assert.match(apply, /private source files were not shared/);
  assert.match(apply, /Community sharing remains a separate action/);

  const renderer = sourceBetween(
    'function renderSermonBodyReview()',
    'function openSermonBodyDialog()'
  );
  assert.match(renderer, /sermonBodySermonSummary\.textContent =/);
  assert.match(renderer, /sermonBodySourceSummary\.textContent =/);
  assert.match(renderer, /sermonBodyPublicationNotice\.textContent =/);
  assert.match(renderer, /returns it to Draft/);
  assert.match(renderer, /separate Community action/);
  assert.match(renderer, /does not send anything to Community or change projected cues/);
  assert.match(renderer, /original PDF, PowerPoint, manuscript, and transcript bytes remain private/);
  assert.doesNotMatch(
    renderer,
    /\b(?:innerHTML|outerHTML|insertAdjacentHTML)\b/
  );
});

test('editing reviewed text or language invalidates confirmation and exposes field errors', () => {
  const { sermonBodyInputInvalidatesConfirmation } = rendererExports();
  let confirmed = true;
  for (const targetId of [
    'reviewSermonBodyText',
    'reviewSermonBodyLanguage'
  ]) {
    if (sermonBodyInputInvalidatesConfirmation(targetId)) confirmed = false;
    assert.equal(confirmed, false);
    confirmed = true;
  }
  assert.equal(
    sermonBodyInputInvalidatesConfirmation('reviewSermonBodyConfirmed'),
    false
  );

  const update = sourceBetween(
    'function updateSermonBodyDraft(event)',
    'async function applySermonBody(event)'
  );
  assert.match(update, /sermonBodyInputInvalidatesConfirmation\(event\?\.target\?\.id\)/);
  assert.match(update, /sermonBodyConfirmed\.checked = false/);

  const controls = sourceBetween(
    'const bodyEntryValidation = state.sermonBodyProposal',
    'const song = row?.item?.kind'
  );
  assert.match(controls, /sermonBodyFieldError\.textContent = bodyFieldError/);
  assert.match(controls, /sermonBodyFieldError\.hidden = !bodyFieldError/);
  assert.match(controls, /sermonBodyLanguage\.setAttribute\(\s*'aria-invalid'/);
  assert.match(controls, /sermonBodyText\.setAttribute\(\s*'aria-invalid'/);
  assert.match(controls, /bodyEntryValidation\?\.valid === true/);

  const meta = sourceBetween(
    'function updateSermonBodyTextMeta()',
    'function scheduleSermonBodyExpiry()'
  );
  assert.match(meta, /bytes over the 1 MB limit; shorten the text before saving/);
});

test('Community sermon conflict projection preserves complete bounded body text without provenance', () => {
  const { projectCommunitySermonConflictCopy } = rendererExports();
  const text = '<script>not markup</script>\n\nComplete reviewed text.';
  const projected = projectCommunitySermonConflictCopy(conflictCopy([{
    position: 1,
    kind: 'manuscript',
    language: 'mul',
    text
  }]), 'local');

  assert.deepEqual(plain(projected.body), [{
    position: 1,
    kind: 'manuscript',
    language: 'mul',
    text,
    metadataFingerprint: 'AAAA-BBBB-CCCC'
  }]);
  assert.equal(Object.hasOwn(projected.body[0], 'sourceId'), false);
  assert.equal(Object.hasOwn(projected.body[0], 'fileName'), false);

  assert.throws(
    () => projectCommunitySermonConflictCopy(conflictCopy([{
      position: 2,
      kind: 'manuscript',
      language: 'en',
      text: 'Out of order'
    }]), 'local'),
    /invalid local sermon body order/
  );
  assert.throws(
    () => projectCommunitySermonConflictCopy(conflictCopy([{
      position: 1,
      kind: 'manuscript',
      language: 'en',
      text: 'Text',
      sourceId: 'private-source'
    }]), 'local'),
    /unsupported local sermon body entry 1 details/
  );
  assert.throws(
    () => projectCommunitySermonConflictCopy(conflictCopy([{
      position: 1,
      kind: 'manuscript',
      language: 'en',
      text: 'é'.repeat((1024 * 1024 / 2) + 1)
    }]), 'local'),
    /invalid local sermon body text/
  );
});

test('Community conflict renders complete body entries as textContent-backed preformatted text', () => {
  const render = sourceBetween(
    'function renderCommunitySermonConflictCopy',
    'function renderCommunitySermonConflictDialog'
  );
  assert.match(render, /Reviewed sermon text/);
  assert.match(render, /createElement\('pre', '', entry\.text\)/);
  assert.match(render, /metadata \$\{entry\.metadataFingerprint\}/);
  assert.match(render, /Metadata markers distinguish hidden entry, source, and outline bindings/);
  assert.match(render, /copy\.body/);
  assert.doesNotMatch(
    render,
    /\b(?:innerHTML|outerHTML|insertAdjacentHTML|document\.write)\b/
  );
  assert.match(cssSource, /\.prepare-sermon-conflict-body-entry pre/);
  assert.match(cssSource, /white-space: pre-wrap/);
});
