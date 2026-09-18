'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const controllerPath = path.join(root, 'src', 'renderer', 'prepare-controller.js');
const controllerSource = fs.readFileSync(controllerPath, 'utf8');
const htmlSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'index.html'), 'utf8');

function rendererExports() {
  const window = {};
  vm.runInNewContext(controllerSource, { console, window }, { filename: controllerPath });
  return window.SyncShowPrepare;
}

function resource(id, title) {
  return {
    id,
    kind: 'sermon',
    sha256: id.slice('sha256:'.length),
    document: {
      id: `sermon-${title.toLowerCase()}`,
      titles: { en: title },
      defaultLanguage: 'en',
      outline: [
        { id: 'foundation', parentId: null, kind: 'section', titles: { en: 'Foundation' } },
        { id: 'application', parentId: null, kind: 'section', titles: { en: 'Application' } }
      ]
    }
  };
}

test('Prepare resolves inherited sermon and outline links with resource-reset semantics', () => {
  const { resolveSermonSourceForItem } = rendererExports();
  const firstId = `sha256:${'a'.repeat(64)}`;
  const secondId = `sha256:${'b'.repeat(64)}`;
  const project = {
    rootItemIds: ['sermon'],
    resources: {
      [firstId]: resource(firstId, 'First'),
      [secondId]: resource(secondId, 'Second')
    },
    items: {
      sermon: {
        id: 'sermon',
        kind: 'group',
        groupKind: 'sermon',
        title: 'Sermon',
        childIds: ['foundation'],
        sermonResourceId: firstId
      },
      foundation: {
        id: 'foundation',
        kind: 'group',
        groupKind: 'point',
        title: 'Foundation',
        childIds: ['slide'],
        sermonSectionId: 'foundation'
      },
      slide: {
        id: 'slide',
        kind: 'sermon',
        title: 'Point',
        sermonResourceId: secondId,
        sermonSectionId: 'application'
      }
    }
  };

  const inherited = resolveSermonSourceForItem(project, 'foundation');
  assert.equal(inherited.resourceId, firstId);
  assert.equal(inherited.sectionId, 'foundation');
  assert.equal(inherited.resourceOwnerId, 'sermon');
  assert.equal(inherited.sectionOwnerId, 'foundation');
  assert.equal(inherited.inherited, true);

  const direct = resolveSermonSourceForItem(project, 'slide');
  assert.equal(direct.resourceId, secondId);
  assert.equal(direct.sectionId, 'application');
  assert.equal(direct.resourceOwnerId, 'slide');
  assert.equal(direct.sectionOwnerId, 'slide');
  assert.equal(direct.inherited, false);
});

test('Prepare offers sermon linking only on sermon cues and semantic outline groups', () => {
  const { isSermonSourceItem } = rendererExports();
  assert.equal(isSermonSourceItem({ kind: 'sermon' }), true);
  for (const groupKind of ['sermon', 'point', 'subpoint']) {
    assert.equal(isSermonSourceItem({ kind: 'group', groupKind }), true);
  }
  assert.equal(isSermonSourceItem({ kind: 'group', groupKind: 'section' }), false);
  assert.equal(isSermonSourceItem({ kind: 'song' }), false);
  assert.equal(isSermonSourceItem({ kind: 'group', groupKind: 'service' }), false);
  assert.equal(isSermonSourceItem({ kind: 'group', groupKind: 'custom' }), false);

  const project = {
    rootItemIds: ['worship', 'sermon'],
    items: {
      worship: {
        id: 'worship',
        kind: 'group',
        groupKind: 'section',
        title: 'Worship',
        childIds: ['song']
      },
      song: { id: 'song', kind: 'song', title: 'Song' },
      sermon: {
        id: 'sermon',
        kind: 'group',
        groupKind: 'sermon',
        title: 'Sermon',
        childIds: ['outline-section']
      },
      'outline-section': {
        id: 'outline-section',
        kind: 'group',
        groupKind: 'section',
        title: 'Application',
        childIds: []
      }
    }
  };
  assert.equal(isSermonSourceItem(project.items.worship, project), false);
  assert.equal(isSermonSourceItem(project.items['outline-section'], project), true);
});

test('Prepare sermon pagination deduplicates shifted pages by stable sermon identity', () => {
  const { mergeSermonSummaries } = rendererExports();
  const merged = mergeSermonSummaries([
    { sermonId: 'sermon-one', sermonRevisionId: 'old-one', title: 'One' },
    { sermonId: 'sermon-two', sermonRevisionId: 'old-two', title: 'Two' }
  ], [
    { sermonId: 'sermon-two', sermonRevisionId: 'new-two', title: 'Two revised' },
    { sermonId: 'sermon-three', sermonRevisionId: 'three', title: 'Three' }
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(merged)), [
    { sermonId: 'sermon-one', sermonRevisionId: 'old-one', title: 'One' },
    { sermonId: 'sermon-two', sermonRevisionId: 'new-two', title: 'Two revised' },
    { sermonId: 'sermon-three', sermonRevisionId: 'three', title: 'Three' }
  ]);
});

test('Prepare preserves an exact bounded set of sermon source languages', () => {
  const { parseSermonSourceLanguages } = rendererExports();
  assert.deepEqual(
    JSON.parse(JSON.stringify(parseSermonSourceLanguages('ru, en; RU'))),
    ['en', 'ru']
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(parseSermonSourceLanguages('zh-Hant en-US'))),
    ['en-us', 'zh-hant']
  );
  assert.equal(parseSermonSourceLanguages(''), null);
  assert.equal(parseSermonSourceLanguages('english'), null);
  assert.equal(parseSermonSourceLanguages('en ru uk de fr es it pt pl'), null);
});

test('Prepare labels source metadata as verified only after a successful host check', () => {
  const { sermonAttachmentHealthSummary } = rendererExports();
  assert.deepEqual(
    JSON.parse(JSON.stringify(sermonAttachmentHealthSummary(2, null))),
    {
      kind: '',
      text: '2 source records · checking this computer…'
    }
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(sermonAttachmentHealthSummary(2, {
      totalCount: 2,
      verifiedCount: 2,
      missingCount: 0,
      corruptCount: 0,
      unverifiedCount: 0
    }))),
    {
      kind: '',
      text: '2 source files verified on this computer'
    }
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(sermonAttachmentHealthSummary(3, {
      totalCount: 3,
      verifiedCount: 1,
      missingCount: 1,
      corruptCount: 1,
      unverifiedCount: 0
    }))),
    {
      kind: 'warning',
      text: '3 source records · 1 verified · 1 missing · 1 failed integrity on this computer'
    }
  );
});

test('Prepare expires cached sermon attachment health after its bounded TTL', () => {
  const { sermonAttachmentHealthCacheValue } = rendererExports();
  const health = {
    totalCount: 1,
    verifiedCount: 1,
    missingCount: 0,
    corruptCount: 0,
    unverifiedCount: 0
  };
  const entry = { health, checkedAt: 10_000 };

  assert.equal(sermonAttachmentHealthCacheValue(entry, 54_999), health);
  assert.equal(sermonAttachmentHealthCacheValue(entry, 55_000), null);
  assert.equal(sermonAttachmentHealthCacheValue(entry, 9_999), null);
  assert.equal(sermonAttachmentHealthCacheValue({ health }, 10_000), null);
});

test('Prepare refreshes health on focus or reselection without a post-attach duplicate', () => {
  assert.match(controllerSource, /const SERMON_ATTACHMENT_HEALTH_TTL_MS = 45_000;/);
  assert.match(
    controllerSource,
    /sermonAttachmentHealthCache\.set\(context\.resourceId, \{\s*health: payload\.health,\s*checkedAt: Date\.now\(\)\s*\}\)/
  );
  assert.match(
    controllerSource,
    /const reselected = state\.selectedItemId === row\.item\.id;[\s\S]{0,900}ensureSelectedSermonAttachmentHealth\(\{ force: reselected \}\)/
  );
  assert.match(
    controllerSource,
    /window\.addEventListener\('focus',[\s\S]{0,220}ensureSelectedSermonAttachmentHealth\(\)/
  );

  const attachStart = controllerSource.indexOf('async function attachSermonSource(event)');
  const attachEnd = controllerSource.indexOf(
    'async function loadTranslationCandidates',
    attachStart
  );
  const attachSource = controllerSource.slice(attachStart, attachEnd);
  const invalidation = attachSource.indexOf(
    'state.sermonAttachmentHealthCache.delete(linked.resourceId)'
  );
  const mutation = attachSource.indexOf('const result = await mutateProject(');
  assert.ok(invalidation >= 0 && invalidation < mutation);
  assert.doesNotMatch(attachSource, /sermonAttachmentHealthCache\.clear\(\)/);
});

test('Prepare includes exact-revision sermon controls and an explicit revision-difference warning', () => {
  for (const id of [
    'prepareSermonInspector',
    'prepareSermonSource',
    'prepareSermonSection',
    'btnLinkSermonSource',
    'prepareSermonLinkedState',
    'btnCreateSermonPacket',
    'createSermonPacketDialog',
    'createSermonPacketReference',
    'createSermonPacketAddReading',
    'btnConfirmCreateSermonPacket',
    'btnAttachSermonSource',
    'attachSermonSourceDialog',
    'attachSermonSourceKind',
    'attachSermonSourceUpdateMetadata',
    'btnConfirmAttachSermonSource',
    'prepareSermonSearch',
    'btnLoadMoreSermons'
  ]) {
    assert.match(htmlSource, new RegExp(`id="${id}"`));
  }
  assert.match(controllerSource, /api\.sourceSermonForServiceItem\(\{/);
  assert.match(controllerSource, /sermonRevisionId,/);
  assert.match(
    controllerSource,
    /A different current library revision exists\. This service remains pinned/
  );
  assert.doesNotMatch(
    controllerSource,
    /sourceSermonForServiceItem\(\{[\s\S]{0,500}(?:document|resourceId|sourcePath|filePath):/
  );
  assert.match(controllerSource, /api\.createSermonPacketForServiceItem\(\{/);
  assert.match(controllerSource, /primaryReference: prepared\.query/);
  assert.match(controllerSource, /addPrimaryReading,/);
  assert.match(
    htmlSource,
    /id="createSermonPacketAddReading" type="checkbox"/
  );
  assert.doesNotMatch(
    htmlSource,
    /id="createSermonPacketAddReading" type="checkbox" checked/
  );
  assert.match(controllerSource, /!elements\.sermonPacketDialog\.open/);
  assert.doesNotMatch(controllerSource, /state\.sermonPacketDialog\.open/);
  const referenceLookupStart = controllerSource.indexOf(
    'async function lookupSermonPacketReference'
  );
  const referenceLookupEnd = controllerSource.indexOf(
    'async function createSermonPacket',
    referenceLookupStart
  );
  assert.ok(referenceLookupStart >= 0 && referenceLookupEnd > referenceLookupStart);
  const referenceLookupSource = controllerSource.slice(
    referenceLookupStart,
    referenceLookupEnd
  );
  assert.match(referenceLookupSource, /api\.lookupSermonPrimaryReference\(\{/);
  assert.doesNotMatch(referenceLookupSource, /api\.lookupBiblePassage\(/);
  assert.doesNotMatch(referenceLookupSource, /\btranslationId\b/);
  assert.doesNotMatch(
    controllerSource,
    /createSermonPacketForServiceItem\(\{[\s\S]{0,700}(?:document|range|sources|publication|sourcePath|filePath):/
  );
  assert.match(controllerSource, /api\.attachSermonSourceForServiceItem\(\{/);
  assert.match(
    controllerSource,
    /attachSermonSourceUpdateMetadata: byId\('attachSermonSourceUpdateMetadata'\)/
  );
  assert.match(
    controllerSource,
    /elements\.attachSermonSourceUpdateMetadata\.disabled = state\.attachSermonBusy \|\| locked/
  );
  assert.match(
    controllerSource,
    /const updateExistingMetadata = elements\.attachSermonSourceUpdateMetadata\.checked;/
  );
  assert.match(controllerSource, /providedBy,\s*updateExistingMetadata\s*\}\)/);
  assert.match(controllerSource, /api\.getSermonAttachmentHealthForServiceItem\(\{/);
  assert.doesNotMatch(
    controllerSource,
    /currentDocument\.sources\?\.length \|\| 0\} .*source/
  );
  assert.match(controllerSource, /expectedSermonRevisionId: linked\.resource\.sha256/);
  assert.doesNotMatch(
    controllerSource,
    /attachSermonSourceForServiceItem\(\{[\s\S]{0,700}(?:sourcePath|filePath|path|source|document|objectId):/
  );
  assert.match(controllerSource, /loadSermons\(\{ append: true \}\)/);
  assert.match(controllerSource, /query: request\.query/);
  assert.match(controllerSource, /alreadyDirectlyLinked/);
  assert.match(controllerSource, /Already linked/);
  assert.match(
    controllerSource,
    /Link the selected packet first, or reselect the pinned revision before attaching a source/
  );
  assert.match(
    htmlSource,
    /id="btnAttachSermonSource"[^>]+aria-describedby="prepareSermonSourceStatus"/
  );
  assert.match(htmlSource, /Source languages <small>BCP-47 codes, separated by commas<\/small>/);
  assert.match(
    htmlSource,
    /id="attachSermonSourceUpdateMetadata" type="checkbox"(?![^>]*\bchecked\b)/
  );
});
