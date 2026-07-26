'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  addProjectItem,
  compileServiceProject,
  createServiceProject,
  normalizeServiceProject,
  removeProjectItemAndDescendants,
  updatePresentationItem
} = require('../src/services/project');

function imageAsset(hex, fileName) {
  return {
    id: `sha256:${hex}`,
    kind: 'image',
    sha256: hex,
    fileName,
    storedName: `${hex}.png`,
    mediaType: 'image/png',
    size: 1024,
    createdAt: '2026-07-23T12:00:00.000Z',
    attribution: '',
    altText: fileName,
    width: 1920,
    height: 1080,
    orientation: 1
  };
}

function projectWithLocalizedAssets() {
  const russianHash = 'a'.repeat(64);
  const englishHash = 'b'.repeat(64);
  const project = createServiceProject({
    id: 'localized-picture-service',
    title: 'Localized picture service',
    serviceDate: '2026-07-19',
    profileId: 'default',
    channels: [
      { id: 'russian', label: 'Russian', language: 'ru' },
      { id: 'english', label: 'English', language: 'en' },
      { id: 'media', label: 'Singers', language: 'ru' }
    ],
    now: new Date('2026-07-23T12:00:00.000Z')
  });
  const raw = JSON.parse(JSON.stringify(project));
  raw.assets[`sha256:${russianHash}`] = imageAsset(russianHash, 'welcome-russian.png');
  raw.assets[`sha256:${englishHash}`] = imageAsset(englishHash, 'welcome-english.png');
  return {
    project: normalizeServiceProject(raw),
    russianAssetId: `sha256:${russianHash}`,
    englishAssetId: `sha256:${englishHash}`
  };
}

test('one picture cue can use a distinct localized image on each output', () => {
  const { project, russianAssetId, englishAssetId } = projectWithLocalizedAssets();
  const localized = addProjectItem(project, {
    id: 'welcome-localized',
    kind: 'picture',
    title: 'Welcome',
    assetIdsByChannel: {
      russian: russianAssetId,
      english: englishAssetId
    },
    fit: 'fill',
    focalPoint: { x: 0.5, y: 0.5 },
    altText: 'Localized welcome slide',
    attribution: '',
    presetId: 'picture-fullscreen',
    operatorNotes: ''
  });

  assert.deepEqual(localized.items['welcome-localized'].assetIdsByChannel, {
    russian: russianAssetId,
    english: englishAssetId
  });
  assert.equal(Object.hasOwn(localized.items['welcome-localized'], 'assetId'), false);

  const timeline = compileServiceProject(localized);
  assert.equal(timeline.cueIds.length, 1);
  const cue = timeline.cues[timeline.cueIds[0]];
  assert.equal(cue.channels.russian.blocks[0].assetId, russianAssetId);
  assert.equal(cue.channels.english.blocks[0].assetId, englishAssetId);
  assert.deepEqual(cue.channels.media, { mode: 'hide', blocks: [] });
});

test('removing a localized picture prunes every image variant from the new revision', () => {
  const { project, russianAssetId, englishAssetId } = projectWithLocalizedAssets();
  const localized = addProjectItem(project, {
    id: 'goodbye-localized',
    kind: 'picture',
    title: 'Goodbye',
    assetIdsByChannel: {
      russian: russianAssetId,
      english: englishAssetId
    },
    fit: 'fit',
    focalPoint: { x: 0.5, y: 0.5 },
    altText: 'Localized goodbye slide',
    attribution: '',
    presetId: 'picture-fullscreen',
    operatorNotes: ''
  });
  const removed = removeProjectItemAndDescendants(localized, 'goodbye-localized');

  assert.deepEqual(removed.rootItemIds, []);
  assert.equal(removed.assets[russianAssetId], undefined);
  assert.equal(removed.assets[englishAssetId], undefined);
});

test('picture description and layout edits preserve every output-specific image', () => {
  const { project, russianAssetId, englishAssetId } = projectWithLocalizedAssets();
  const localized = addProjectItem(project, {
    id: 'editable-localized-picture',
    kind: 'picture',
    title: 'Welcome',
    assetIdsByChannel: {
      russian: russianAssetId,
      english: englishAssetId
    },
    fit: 'fit',
    focalPoint: { x: 0.5, y: 0.5 },
    altText: 'Localized welcome slide',
    attribution: '',
    presetId: 'picture-fullscreen',
    operatorNotes: ''
  });
  const edited = updatePresentationItem(localized, {
    itemId: 'editable-localized-picture',
    title: 'Welcome image',
    altText: 'Localized welcome artwork',
    fit: 'fill',
    operatorNotes: 'Advance after the greeting.',
    now: '2026-07-23T12:10:00.000Z'
  });

  assert.deepEqual(edited.items['editable-localized-picture'].assetIdsByChannel, {
    russian: russianAssetId,
    english: englishAssetId
  });
  assert.equal(Object.hasOwn(edited.items['editable-localized-picture'], 'assetId'), false);
});

test('legacy one-image picture items retain their existing shape and routing', () => {
  const { project, russianAssetId } = projectWithLocalizedAssets();
  const legacy = addProjectItem(project, {
    id: 'legacy-picture',
    kind: 'picture',
    title: 'Legacy picture',
    assetId: russianAssetId,
    channelIds: ['russian', 'media'],
    fit: 'fit',
    focalPoint: { x: 0.5, y: 0.5 },
    altText: 'One shared picture',
    attribution: '',
    presetId: 'picture-fullscreen',
    operatorNotes: ''
  });

  assert.equal(legacy.items['legacy-picture'].assetId, russianAssetId);
  assert.deepEqual(legacy.items['legacy-picture'].channelIds, ['russian', 'media']);
  assert.equal(Object.hasOwn(legacy.items['legacy-picture'], 'assetIdsByChannel'), false);
});
