'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const controllerPath = path.resolve(__dirname, '../src/renderer/prepare-controller.js');
const controllerSource = fs.readFileSync(controllerPath, 'utf8');

function rendererHelper() {
  const window = {};
  vm.runInNewContext(controllerSource, { console, window }, { filename: controllerPath });
  return window.SyncShowPrepare.authoritativeSongForItem;
}

function rendererExports() {
  const window = {};
  vm.runInNewContext(controllerSource, { console, window }, { filename: controllerPath });
  return window.SyncShowPrepare;
}

function fixture() {
  const originalResourceId = `sha256:${'a'.repeat(64)}`;
  const translationResourceId = `sha256:${'b'.repeat(64)}`;
  const project = {
    channelIds: ['media', 'primary', 'secondary'],
    resources: {
      [originalResourceId]: {
        kind: 'song',
        document: {
          id: 'steadfast-love',
          title: 'Steadfast Love',
          language: 'en',
          translationOf: ''
        }
      },
      [translationResourceId]: {
        kind: 'song',
        document: {
          id: 'steadfast-love-uk',
          title: 'Вірна любов',
          language: 'uk',
          translationOf: 'steadfast-love'
        }
      }
    }
  };
  const item = {
    id: 'song-steadfast-love',
    kind: 'song',
    variants: {
      media: { mode: 'content', resourceId: translationResourceId },
      primary: { mode: 'content', resourceId: originalResourceId },
      secondary: { mode: 'inherit', from: 'primary' }
    }
  };
  return { project, item, originalResourceId, translationResourceId };
}

test('Prepare uses the authoritative original instead of the first media translation', () => {
  const authoritativeSongForItem = rendererHelper();
  assert.equal(typeof authoritativeSongForItem, 'function');
  const { project, item, translationResourceId } = fixture();

  const linkedMedia = authoritativeSongForItem(project, item);
  assert.equal(linkedMedia.channelId, 'primary');
  assert.equal(linkedMedia.document.id, 'steadfast-love');

  item.variants.media = {
    mode: 'derive',
    from: 'primary',
    transform: { id: 'first-lines', version: 1, maxLines: 2 }
  };
  item.variants.secondary = { mode: 'content', resourceId: translationResourceId };
  const resetMediaLinkedSecondary = authoritativeSongForItem(project, item);
  assert.equal(resetMediaLinkedSecondary.channelId, 'primary');
  assert.equal(resetMediaLinkedSecondary.document.id, 'steadfast-love');

  item.primaryChannelId = 'primary';
  item.variants.media = { mode: 'content', resourceId: translationResourceId };
  const persisted = authoritativeSongForItem(project, item);
  assert.equal(persisted.channelId, 'primary');
  assert.equal(persisted.document.id, 'steadfast-love');
});

test('Prepare credit summaries distinguish words, translation, and music', () => {
  const { songCreditSummary } = rendererExports();
  assert.equal(
    songCreditSummary({
      authors: ['Words Author'],
      translators: ['Translation Author'],
      composers: ['Music Composer']
    }),
    'Words: Words Author · Translation: Translation Author · Music: Music Composer'
  );
});

test('Prepare groups originals and translations into visible song families', () => {
  const { groupSongSummaries, songFamilyRelationship } = rendererExports();
  const groups = groupSongSummaries([
    {
      id: 'grace-es',
      title: 'Sublime gracia',
      language: 'es',
      translationOf: 'grace',
      revision: 'revision-es'
    },
    {
      id: 'grace',
      title: 'Amazing Grace',
      language: 'en',
      translationOf: null,
      revision: 'revision-en'
    },
    {
      id: 'solo',
      title: 'One Language',
      language: 'en',
      translationOf: null,
      revision: 'revision-solo'
    },
    {
      id: 'hidden-root-uk',
      title: 'Прихований корінь',
      language: 'uk',
      translationOf: 'hidden-root',
      revision: 'revision-uk'
    }
  ]);

  assert.equal(groups.length, 3);
  assert.equal(groups[0].familyId, 'grace');
  assert.equal(groups[0].original.id, 'grace');
  assert.equal(groups[0].translations.length, 1);
  assert.equal(groups[0].translations[0].id, 'grace-es');
  assert.equal(groups[0].versions[0].id, 'grace');
  assert.equal(groups[1].familyId, 'solo');
  assert.equal(groups[1].translations.length, 0);
  assert.equal(groups[2].familyId, 'hidden-root');
  assert.equal(groups[2].original, null);
  assert.equal(groups[2].versions[0].id, 'hidden-root-uk');
  assert.equal(
    songFamilyRelationship(groups[0], { complete: true }),
    'Original · 1 translation'
  );
  assert.equal(
    songFamilyRelationship(groups[0], { complete: false }),
    'Original · 1 translation loaded'
  );
  assert.equal(
    songFamilyRelationship(groups[0], { searching: true }),
    'Original · 1 translation matching this search'
  );
  assert.equal(
    songFamilyRelationship(groups[1], { searching: true }),
    'Original · other translations may be outside this search'
  );
  const missingRootCopy = songFamilyRelationship(groups[2], { complete: false });
  assert.equal(missingRootCopy, 'Translation · original not loaded in this view');
  assert.equal(missingRootCopy.includes('hidden-root'), false);
});

test('Prepare service-item draft snapshots include per-output text and emphasis', () => {
  const { editItemDraftSnapshot } = rendererExports();
  const draft = {
    itemId: 'sermon-grace',
    title: 'Grace',
    operatorNotes: 'Pause here',
    presetId: 'sermon-point',
    channels: [{
      channelId: 'primary',
      title: 'Grace alone',
      text: 'Saved by grace',
      spans: [{ start: 9, end: 14, gold: true }]
    }]
  };

  const original = editItemDraftSnapshot(draft);
  const changedText = editItemDraftSnapshot({
    ...draft,
    channels: [{ ...draft.channels[0], text: 'Saved by grace alone' }]
  });
  const changedEmphasis = editItemDraftSnapshot({
    ...draft,
    channels: [{
      ...draft.channels[0],
      spans: [{ start: 0, end: 5, gold: true }]
    }]
  });

  assert.equal(original, editItemDraftSnapshot(JSON.parse(JSON.stringify(draft))));
  assert.notEqual(original, changedText);
  assert.notEqual(original, changedEmphasis);
});

test('Prepare turns an exact body selection into bounded gold emphasis without changing text', () => {
  const {
    addGoldEmphasisRange,
    emphasisSnippet,
    normalizeEditableEmphasisRanges
  } = rendererExports();
  const raw = '  Еф.3:1 <b>благодать</b> and 😀 hope  ';
  const firstStart = raw.indexOf('Еф.3:1');
  const firstEnd = firstStart + 'Еф.3:1'.length;
  const first = addGoldEmphasisRange([], raw, firstStart, firstEnd);

  assert.equal(first.text, 'Еф.3:1 <b>благодать</b> and 😀 hope');
  assert.deepEqual(JSON.parse(JSON.stringify(first.ranges)), [{
    start: 0,
    end: 'Еф.3:1'.length,
    gold: true
  }]);
  assert.equal(emphasisSnippet(first.text, first.addedRange), 'Еф.3:1');

  const graceStart = raw.indexOf('<b>');
  const graceEnd = raw.indexOf('</b>') + '</b>'.length;
  const second = addGoldEmphasisRange(first.ranges, raw, graceStart, graceEnd);
  assert.deepEqual(
    JSON.parse(JSON.stringify(second.ranges)),
    [
      { start: 0, end: 6, gold: true },
      { start: 7, end: 23, gold: true }
    ],
    'literal angle brackets remain ordinary selected text, never renderer markup'
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(normalizeEditableEmphasisRanges(second.ranges, second.text))),
    JSON.parse(JSON.stringify(second.ranges))
  );
});

test('Prepare emphasis rejects empty, overlapping, split-character, stale, and excessive ranges', () => {
  const { addGoldEmphasisRange, normalizeEditableEmphasisRanges } = rendererExports();
  assert.throws(
    () => addGoldEmphasisRange([], 'Grace and truth', 0, 0),
    error => error.code === 'EMPHASIS_SELECTION_REQUIRED'
  );
  assert.throws(
    () => addGoldEmphasisRange([], 'Grace and truth', 5, 6),
    error => error.code === 'EMPHASIS_SELECTION_REQUIRED'
  );
  assert.throws(
    () => addGoldEmphasisRange([{ start: 0, end: 5 }], 'Grace and truth', 3, 9),
    error => error.code === 'OVERLAPPING_EMPHASIS'
  );
  assert.throws(
    () => addGoldEmphasisRange([], 'A😀B', 2, 3),
    error => error.code === 'INVALID_EMPHASIS_SELECTION'
  );
  assert.throws(
    () => normalizeEditableEmphasisRanges([{ start: 8, end: 20 }], 'Short body'),
    error => error.code === 'INVALID_EMPHASIS_RANGES'
  );

  const maximum = Array.from({ length: 256 }, (_unused, index) => ({
    start: index * 2,
    end: index * 2 + 1
  }));
  assert.throws(
    () => addGoldEmphasisRange(maximum, `${'x '.repeat(256)}more`, 512, 516),
    error => error.code === 'TOO_MANY_EMPHASIS_RANGES'
  );
});

test('rundown drag destinations reorder within and across sections without creating cycles', () => {
  const { reorderDestination } = rendererExports();
  const project = {
    rootItemIds: ['opening', 'worship', 'closing'],
    items: {
      opening: { id: 'opening', kind: 'notice', title: 'Opening' },
      worship: {
        id: 'worship',
        kind: 'group',
        title: 'Worship',
        childIds: ['song-one', 'song-two']
      },
      'song-one': { id: 'song-one', kind: 'song', title: 'Song one' },
      'song-two': { id: 'song-two', kind: 'song', title: 'Song two' },
      closing: { id: 'closing', kind: 'notice', title: 'Closing' }
    }
  };

  assert.deepEqual(
    JSON.parse(JSON.stringify(reorderDestination(project, 'opening', 'closing', 'after'))),
    { targetParentId: null, targetIndex: 2 }
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(reorderDestination(project, 'song-two', 'opening', 'before'))),
    { targetParentId: null, targetIndex: 0 }
  );
  assert.equal(reorderDestination(project, 'song-one', 'song-two', 'before'), null);
  assert.equal(reorderDestination(project, 'worship', 'song-one', 'after'), null);
});
