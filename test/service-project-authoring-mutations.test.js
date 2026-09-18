'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ServiceProjectError,
  addGroupItem,
  addProjectItem,
  addSongResource,
  compileServiceProject,
  createServiceProject,
  duplicateProjectItem,
  normalizeServiceProject,
  parseSongDocument,
  planNextServiceProject,
  removeProjectItemAndDescendants,
  replaceSongItem,
  serializeServiceProject,
  updateGroupItem,
  updatePictureChannelAsset,
  updatePresentationItem,
  updateTextItem
} = require('../src/services/project');

const NOW = '2026-07-23T20:00:00.000Z';

function expectProjectCode(code, callback) {
  assert.throws(callback, error => {
    assert.ok(error instanceof ServiceProjectError);
    assert.equal(error.code, code);
    return true;
  });
}

function freshProject() {
  return createServiceProject({
    id: 'authoring-service',
    title: 'Authoring Service',
    serviceDate: '2026-07-26',
    profileId: 'main-sanctuary',
    now: NOW,
    channels: [
      { id: 'primary', label: 'Main', language: 'en' },
      { id: 'secondary', label: 'Second language', language: 'uk' }
    ]
  });
}

function projectWithSermon() {
  let project = addGroupItem(freshProject(), {
    id: 'sermon-outline',
    title: 'Sermon',
    groupKind: 'sermon',
    now: NOW
  });
  project = addProjectItem(project, {
    id: 'sermon-point-one',
    kind: 'sermon',
    title: 'First point',
    textByChannel: {
      primary: 'Grace changes us.',
      secondary: 'Благодать змінює нас.'
    },
    presetId: 'sermon-point',
    operatorNotes: 'Pause before this point.'
  }, {
    parentId: 'sermon-outline',
    now: NOW
  });
  return project;
}

function projectWithSongSubtree() {
  let project = addGroupItem(freshProject(), {
    id: 'worship',
    title: 'Worship',
    groupKind: 'section',
    now: NOW
  });
  const song = parseSongDocument([
    '---',
    'id: grace-song',
    'title: Grace Song',
    'language: en',
    '---',
    '^1',
    'Grace upon grace',
    '^chorus',
    'Sing of His mercy'
  ].join('\n'));
  const pinned = addSongResource(project, song, {
    provider: 'local',
    itemId: song.id,
    revision: 'song-revision-one'
  });
  project = addProjectItem(pinned.project, {
    id: 'song-grace',
    kind: 'song',
    title: song.title,
    variants: {
      primary: { mode: 'content', resourceId: pinned.resourceId },
      secondary: { mode: 'inherit', from: 'primary' }
    },
    arrangement: [
      { id: 'arr-verse-one', sectionId: 'verse-1' },
      { id: 'arr-chorus-one', sectionId: 'chorus' }
    ],
    titlePresetId: 'song-title',
    lyricsPresetId: 'song-lyrics',
    operatorNotes: ''
  }, {
    parentId: 'worship',
    now: NOW
  });
  project = addProjectItem(project, {
    id: 'worship-notice',
    kind: 'notice',
    title: 'Please stand',
    textByChannel: {
      primary: 'Please stand',
      secondary: 'Будь ласка, встаньте'
    },
    presetId: 'notice-text',
    operatorNotes: ''
  }, {
    parentId: 'worship',
    now: NOW
  });
  return project;
}

function replacementSongFor(project, overrides = {}) {
  const song = parseSongDocument([
    '---',
    'id: mercy-song',
    'title: Mercy Song',
    'language: en',
    '---',
    '^1',
    'Morning by morning',
    '^chorus',
    'Great is Your mercy'
  ].join('\n'));
  const pinned = addSongResource(project, song, {
    provider: 'local',
    itemId: song.id,
    revision: 'song-revision-two'
  });
  return {
    project: pinned.project,
    resourceId: pinned.resourceId,
    item: {
      id: 'song-mercy',
      kind: 'song',
      title: song.title,
      primaryChannelId: 'primary',
      variants: {
        primary: { mode: 'content', resourceId: pinned.resourceId },
        secondary: { mode: 'inherit', from: 'primary' }
      },
      arrangement: [
        { id: 'arr-mercy-verse-one', sectionId: 'verse-1' },
        { id: 'arr-mercy-chorus-one', sectionId: 'chorus' }
      ],
      titlePresetId: 'song-title',
      lyricsPresetId: 'song-lyrics',
      operatorNotes: '',
      ...overrides
    }
  };
}

test('subtree removal prunes only last-reference song and picture records', () => {
  const original = projectWithSongSubtree();
  const originalSong = original.items['song-grace'];
  const sourceResourceId = originalSong.variants.primary.resourceId;
  let shared = addProjectItem(original, {
    ...JSON.parse(JSON.stringify(originalSong)),
    id: 'song-grace-shared',
    title: 'Grace Song shared',
    arrangement: originalSong.arrangement.map((entry, index) => ({
      id: `arr-shared-${index + 1}`,
      sectionId: entry.sectionId
    }))
  }, { now: NOW });

  const assetHash = 'a'.repeat(64);
  const assetId = `sha256:${assetHash}`;
  const raw = JSON.parse(serializeServiceProject(shared));
  raw.assets[assetId] = {
    id: assetId,
    kind: 'image',
    sha256: assetHash,
    fileName: 'shared.png',
    storedName: `${assetHash}.png`,
    mediaType: 'image/png',
    size: 128,
    createdAt: NOW,
    attribution: '',
    altText: 'Shared picture',
    width: 1280,
    height: 720,
    orientation: 1
  };
  shared = normalizeServiceProject(raw);
  shared = addProjectItem(shared, {
    id: 'picture-inside-worship',
    kind: 'picture',
    title: 'Inside worship',
    assetId,
    channelIds: ['primary', 'secondary'],
    fit: 'fit',
    focalPoint: { x: 0.5, y: 0.5 },
    altText: 'Shared picture',
    attribution: '',
    presetId: 'picture-fullscreen',
    operatorNotes: ''
  }, { parentId: 'worship', now: NOW });
  shared = addProjectItem(shared, {
    id: 'picture-shared-root',
    kind: 'picture',
    title: 'Shared at root',
    assetId,
    channelIds: ['primary', 'secondary'],
    fit: 'fit',
    focalPoint: { x: 0.5, y: 0.5 },
    altText: 'Shared picture',
    attribution: '',
    presetId: 'picture-fullscreen',
    operatorNotes: ''
  }, { now: NOW });

  const afterGroupRemoval = removeProjectItemAndDescendants(shared, 'worship');
  assert.equal(afterGroupRemoval.items.worship, undefined);
  assert.ok(afterGroupRemoval.items['song-grace-shared']);
  assert.ok(afterGroupRemoval.items['picture-shared-root']);
  assert.ok(afterGroupRemoval.resources[sourceResourceId], 'a shared song resource remains reachable');
  assert.ok(afterGroupRemoval.assets[assetId], 'a shared picture asset remains reachable');

  const afterSongRemoval = removeProjectItemAndDescendants(afterGroupRemoval, 'song-grace-shared');
  assert.equal(afterSongRemoval.resources[sourceResourceId], undefined);
  assert.ok(afterSongRemoval.assets[assetId]);

  const afterPictureRemoval = removeProjectItemAndDescendants(afterSongRemoval, 'picture-shared-root');
  assert.equal(afterPictureRemoval.assets[assetId], undefined);
  assert.ok(original.items.worship, 'the immutable input project remains unchanged');
  assert.ok(Object.isFrozen(afterPictureRemoval));
});

test('native song replacement preserves the exact parent and index with fresh cue identities', () => {
  const original = projectWithSongSubtree();
  const originalBytes = serializeServiceProject(original);
  const sourceResourceId =
    original.items['song-grace'].variants.primary.resourceId;
  const originalTimeline = compileServiceProject(original);
  const originalCueIds = originalTimeline.cueIds.filter(cueId =>
    originalTimeline.cues[cueId].itemId === 'song-grace');
  const prepared = replacementSongFor(original);
  const preparedBytes = serializeServiceProject(prepared.project);

  const replaced = replaceSongItem(
    prepared.project,
    'song-grace',
    prepared.item,
    { now: '2026-07-23T20:04:00.000Z' }
  );

  assert.deepEqual(replaced.rootItemIds, ['worship']);
  assert.deepEqual(
    replaced.items.worship.childIds,
    ['song-mercy', 'worship-notice']
  );
  assert.equal(replaced.items['song-grace'], undefined);
  assert.equal(replaced.items['song-mercy'].kind, 'song');
  assert.equal(
    replaced.items['song-mercy'].variants.primary.resourceId,
    prepared.resourceId
  );
  assert.equal(replaced.resources[sourceResourceId], undefined);
  assert.ok(replaced.resources[prepared.resourceId]);

  const timeline = compileServiceProject(replaced);
  const replacementCueIds = timeline.cueIds.filter(cueId =>
    timeline.cues[cueId].itemId === 'song-mercy');
  const replacementStart = timeline.cueIds.indexOf(replacementCueIds[0]);
  const noticeStart = timeline.cueIds.findIndex(cueId =>
    timeline.cues[cueId].itemId === 'worship-notice');
  assert.ok(replacementCueIds.length > 0);
  assert.ok(replacementStart >= 0 && replacementStart < noticeStart);
  assert.equal(
    replacementCueIds.some(cueId => originalCueIds.includes(cueId)),
    false,
    'the fresh item and arrangement identities must produce fresh Cue identities'
  );
  assert.equal(
    timeline.cueIds.some(cueId => timeline.cues[cueId].itemId === 'song-grace'),
    false
  );
  assert.equal(serializeServiceProject(original), originalBytes);
  assert.equal(serializeServiceProject(prepared.project), preparedBytes);
  assert.ok(Object.isFrozen(replaced));
});

test('native song replacement retains an original resource used by another occurrence', () => {
  const original = projectWithSongSubtree();
  const source = original.items['song-grace'];
  const sourceResourceId = source.variants.primary.resourceId;
  let shared = addProjectItem(original, {
    ...structuredClone(source),
    id: 'song-grace-reprise',
    title: 'Grace Song reprise',
    arrangement: source.arrangement.map((entry, index) => ({
      id: `arr-reprise-${index + 1}`,
      sectionId: entry.sectionId
    }))
  }, { now: NOW });
  const prepared = replacementSongFor(shared);

  shared = replaceSongItem(
    prepared.project,
    'song-grace-reprise',
    prepared.item,
    { now: '2026-07-23T20:04:30.000Z' }
  );

  assert.deepEqual(shared.rootItemIds, ['worship', 'song-mercy']);
  assert.ok(shared.items['song-grace']);
  assert.equal(shared.items['song-grace-reprise'], undefined);
  assert.ok(
    shared.resources[sourceResourceId],
    'the original stays pinned while the nested occurrence still reaches it'
  );
  assert.ok(shared.resources[prepared.resourceId]);
});

test('native song replacement rejects non-song targets and reused identities', () => {
  const original = projectWithSongSubtree();
  const prepared = replacementSongFor(original);

  expectProjectCode('WRONG_PROJECT_ITEM_KIND', () => replaceSongItem(
    prepared.project,
    'worship-notice',
    prepared.item,
    { now: NOW }
  ));
  expectProjectCode('SONG_REPLACEMENT_ID_REUSED', () => replaceSongItem(
    prepared.project,
    'song-grace',
    { ...prepared.item, id: 'song-grace' },
    { now: NOW }
  ));
  expectProjectCode('INVALID_SONG_REPLACEMENT', () => replaceSongItem(
    prepared.project,
    'song-grace',
    {
      id: 'replacement-notice',
      kind: 'notice',
      title: 'Not a song',
      textByChannel: {
        primary: 'Not a song',
        secondary: 'Not a song'
      },
      presetId: 'notice-text',
      operatorNotes: ''
    },
    { now: NOW }
  ));
});

function projectWithPicture() {
  const raw = structuredClone(freshProject());
  const sha256 = 'd'.repeat(64);
  const assetId = `sha256:${sha256}`;
  raw.assets[assetId] = {
    id: assetId,
    kind: 'image',
    sha256,
    fileName: 'welcome.png',
    storedName: `${sha256}.png`,
    mediaType: 'image/png',
    size: 4096,
    createdAt: NOW,
    attribution: 'Church archive',
    altText: 'The congregation gathering',
    width: 1920,
    height: 1080,
    orientation: 1
  };
  return addProjectItem(raw, {
    id: 'welcome-picture',
    kind: 'picture',
    title: 'Welcome',
    assetId,
    channelIds: ['primary'],
    fit: 'fit',
    focalPoint: { x: 0.5, y: 0.5 },
    altText: 'The congregation gathering',
    attribution: 'Church archive',
    presetId: 'picture-fullscreen',
    operatorNotes: ''
  }, { now: NOW });
}

function projectWithReviewedPicture() {
  const raw = structuredClone(projectWithPicture());
  const item = raw.items['welcome-picture'];
  const assetIdsByChannel = {
    primary: item.assetId,
    secondary: item.assetId
  };
  delete item.assetId;
  delete item.channelIds;
  item.assetIdsByChannel = assetIdsByChannel;
  raw.sourceServiceSet = {
    id: 'reviewed-service-set',
    fingerprint: 'a'.repeat(64),
    serviceDate: raw.serviceDate,
    profileId: raw.preferredProfileId
  };
  item.sourceVisualReview = {
    schemaVersion: 1,
    kind: 'powerpoint-render',
    serviceSetId: raw.sourceServiceSet.id,
    serviceSetFingerprint: raw.sourceServiceSet.fingerprint,
    renderRevisionId: 'b'.repeat(64),
    position: 1,
    assetIdsByChannel
  };
  return normalizeServiceProject(raw);
}

test('group renames preserve item, descendant, and compiled cue identities', () => {
  const original = projectWithSermon();
  const originalTimeline = compileServiceProject(original);
  const updated = updateGroupItem(original, {
    itemId: 'sermon-outline',
    title: 'The Grace of God',
    groupKind: 'section',
    operatorNotes: 'Sermon begins here.',
    now: '2026-07-23T20:05:00.000Z'
  });
  const updatedTimeline = compileServiceProject(updated);

  assert.equal(updated.items['sermon-outline'].id, 'sermon-outline');
  assert.equal(updated.items['sermon-outline'].title, 'The Grace of God');
  assert.equal(updated.items['sermon-outline'].groupKind, 'section');
  assert.equal(updated.items['sermon-outline'].operatorNotes, 'Sermon begins here.');
  assert.deepEqual(updated.items['sermon-outline'].childIds, ['sermon-point-one']);
  assert.deepEqual(updatedTimeline.cueIds, originalTimeline.cueIds);
  assert.deepEqual(
    updatedTimeline.cues[updatedTimeline.cueIds[0]].groupPath,
    ['The Grace of God']
  );
  assert.equal(original.items['sermon-outline'].title, 'Sermon');
  assert.ok(Object.isFrozen(updated));

  expectProjectCode('WRONG_PROJECT_ITEM_KIND', () => updateGroupItem(original, {
    itemId: 'sermon-point-one',
    title: 'Not a group',
    now: NOW
  }));
});

test('text edits keep cue identity stable and accept only catalog presets for that kind', () => {
  const original = projectWithSermon();
  const originalTimeline = compileServiceProject(original);
  const updated = updateTextItem(original, {
    itemId: 'sermon-point-one',
    title: 'Grace transforms',
    textByChannel: {
      primary: 'Grace transforms the whole person.',
      secondary: 'Благодать змінює всю людину.'
    },
    presetId: 'sermon-title',
    operatorNotes: 'Let the title settle.',
    now: '2026-07-23T20:10:00.000Z'
  });
  const updatedTimeline = compileServiceProject(updated);
  const cue = updatedTimeline.cues[updatedTimeline.cueIds[0]];

  assert.deepEqual(updatedTimeline.cueIds, originalTimeline.cueIds);
  assert.equal(updated.items['sermon-point-one'].presetId, 'sermon-title');
  assert.equal(cue.title, 'Grace transforms');
  assert.equal(cue.presetId, 'sermon-title');
  assert.equal(cue.channels.primary.blocks[0].text, 'Grace transforms the whole person.');
  assert.equal(cue.channels.secondary.blocks[0].text, 'Благодать змінює всю людину.');
  assert.equal(original.items['sermon-point-one'].presetId, 'sermon-point');

  expectProjectCode('INVALID_NATIVE_PRESET', () => updateTextItem(original, {
    itemId: 'sermon-point-one',
    presetId: 'scripture-large',
    now: NOW
  }));
  expectProjectCode('UNKNOWN_PROJECT_CHANNEL', () => updateTextItem(original, {
    itemId: 'sermon-point-one',
    textByChannel: { balcony: 'Untrusted output' },
    now: NOW
  }));
  expectProjectCode('INVALID_NATIVE_PRESET', () => updateTextItem(original, {
    itemId: 'sermon-point-one',
    presetId: 'made-up-preset',
    now: NOW
  }));
});

test('text edits retain inline spans only for byte-identical channel text', () => {
  const raw = JSON.parse(serializeServiceProject(projectWithSermon()));
  raw.items['sermon-point-one'].spansByChannel = {
    primary: [{ start: 0, end: 5, foreground: '#FFC000', weight: '700' }],
    secondary: [{ start: 0, end: 9, foreground: '#ffc000' }]
  };
  const original = normalizeServiceProject(raw);
  const metadataOnly = updateTextItem(original, {
    itemId: 'sermon-point-one',
    title: 'First point renamed',
    now: '2026-07-23T20:09:00.000Z'
  });
  assert.deepEqual(
    metadataOnly.items['sermon-point-one'].spansByChannel,
    original.items['sermon-point-one'].spansByChannel
  );

  const updated = updateTextItem(original, {
    itemId: 'sermon-point-one',
    textByChannel: {
      primary: 'Grace changes us.',
      secondary: 'Цей текст змінився.'
    },
    now: '2026-07-23T20:10:00.000Z'
  });
  assert.deepEqual(updated.items['sermon-point-one'].spansByChannel, {
    primary: [{ start: 0, end: 5, foreground: '#ffc000', weight: '700' }]
  });
  const cue = compileServiceProject(updated).cues[
    compileServiceProject(updated).cueIds[0]
  ];
  assert.deepEqual(cue.channels.primary.blocks[0].spans, [
    { start: 0, end: 5, foreground: '#ffc000', weight: '700' }
  ]);
  assert.equal(cue.channels.secondary.blocks[0].spans, undefined);

  const removed = updateTextItem(updated, {
    itemId: 'sermon-point-one',
    textByChannel: {
      secondary: 'Цей текст змінився.'
    },
    now: '2026-07-23T20:11:00.000Z'
  });
  assert.equal(removed.items['sermon-point-one'].spansByChannel, undefined);
  assert.ok(original.items['sermon-point-one'].spansByChannel.secondary);
});

test('text authoring can explicitly set, replace, and clear validated inline spans', () => {
  const original = projectWithSermon();
  const primaryText = 'Grace <tag> changes us.';
  const primaryEnd = primaryText.indexOf(' changes');
  const authored = updateTextItem(original, {
    itemId: 'sermon-point-one',
    textByChannel: {
      primary: primaryText,
      secondary: original.items['sermon-point-one'].textByChannel.secondary
    },
    spansByChannel: {
      primary: [{
        start: 0,
        end: primaryEnd,
        foreground: '#FFC000',
        weight: '700'
      }]
    },
    now: '2026-07-23T20:12:00.000Z'
  });
  assert.deepEqual(authored.items['sermon-point-one'].spansByChannel, {
    primary: [{
      start: 0,
      end: primaryEnd,
      foreground: '#ffc000',
      weight: '700'
    }]
  });
  const timeline = compileServiceProject(authored);
  assert.equal(timeline.cues[timeline.cueIds[0]].channels.primary.blocks[0].text, primaryText);
  assert.deepEqual(
    timeline.cues[timeline.cueIds[0]].channels.primary.blocks[0].spans,
    authored.items['sermon-point-one'].spansByChannel.primary
  );

  const secondaryText = authored.items['sermon-point-one'].textByChannel.secondary;
  const replaced = updateTextItem(authored, {
    itemId: 'sermon-point-one',
    spansByChannel: {
      secondary: [{ start: 0, end: 9, foreground: '#ffc000' }]
    },
    now: '2026-07-23T20:13:00.000Z'
  });
  assert.deepEqual(replaced.items['sermon-point-one'].spansByChannel, {
    secondary: [{ start: 0, end: 9, foreground: '#ffc000' }]
  });
  assert.equal(secondaryText.startsWith('Благодать'), true);

  const cleared = updateTextItem(replaced, {
    itemId: 'sermon-point-one',
    spansByChannel: null,
    now: '2026-07-23T20:14:00.000Z'
  });
  assert.equal(cleared.items['sermon-point-one'].spansByChannel, undefined);

  expectProjectCode('INVALID_TEXT_SPANS', () => updateTextItem(original, {
    itemId: 'sermon-point-one',
    spansByChannel: {
      primary: [{ start: 0, end: 999, foreground: '#ffc000' }]
    },
    now: NOW
  }));
  expectProjectCode('UNKNOWN_PROJECT_CHANNEL', () => updateTextItem(original, {
    itemId: 'sermon-point-one',
    spansByChannel: {
      balcony: [{ start: 0, end: 1, foreground: '#ffc000' }]
    },
    now: NOW
  }));
});

test('song presentation edits preserve pinned lyrics and accept only song presets', () => {
  const original = projectWithSongSubtree();
  const resourceId = original.items['song-grace'].variants.primary.resourceId;
  const originalTimeline = compileServiceProject(original);
  const updated = updatePresentationItem(original, {
    itemId: 'song-grace',
    title: 'Grace Song — Closing',
    presetId: 'song-lyrics-large',
    operatorNotes: 'Repeat the final chorus if needed.',
    now: '2026-07-23T20:12:00.000Z'
  });
  const timeline = compileServiceProject(updated);

  assert.equal(updated.items['song-grace'].lyricsPresetId, 'song-lyrics-large');
  assert.equal(updated.items['song-grace'].variants.primary.resourceId, resourceId);
  assert.deepEqual(updated.resources[resourceId], original.resources[resourceId]);
  assert.equal(updated.items['song-grace'].operatorNotes, 'Repeat the final chorus if needed.');
  assert.deepEqual(timeline.cueIds, originalTimeline.cueIds);
  const songCues = timeline.cueIds
    .map(cueId => timeline.cues[cueId])
    .filter(cue => cue.itemId === 'song-grace');
  assert.equal(songCues[0].presetId, 'song-title');
  assert.ok(songCues
    .slice(1)
    .every(cue => cue.presetId === 'song-lyrics-large'));

  expectProjectCode('INVALID_NATIVE_PRESET', () => updatePresentationItem(original, {
    itemId: 'song-grace',
    presetId: 'scripture-large',
    now: NOW
  }));
});

test('picture presentation edits can correct accessibility text without replacing the pinned image', () => {
  const original = projectWithPicture();
  const item = original.items['welcome-picture'];
  const updated = updatePresentationItem(original, {
    itemId: item.id,
    title: 'Welcome photo',
    altText: 'Families greeting one another before worship',
    fit: 'fill',
    attribution: 'Heritage Church archive',
    now: '2026-07-23T20:13:00.000Z'
  });
  const changed = updated.items[item.id];

  assert.equal(changed.assetId, item.assetId);
  assert.equal(changed.altText, 'Families greeting one another before worship');
  assert.equal(changed.title, 'Welcome photo');
  assert.equal(changed.fit, 'fill');
  assert.equal(changed.attribution, 'Heritage Church archive');
  assert.equal(original.items[item.id].altText, 'The congregation gathering');

  expectProjectCode('MISSING_TEXT', () => updatePresentationItem(original, {
    itemId: item.id,
    altText: '   ',
    now: NOW
  }));
});

test('picture edits and duplication clear source visual provenance without altering the original', () => {
  const original = projectWithReviewedPicture();
  const item = original.items['welcome-picture'];
  assert.equal(item.sourceVisualReview.position, 1);

  const edited = updatePresentationItem(original, {
    itemId: item.id,
    title: 'Reviewed picture, adjusted',
    now: '2026-07-23T20:13:30.000Z'
  });
  assert.equal(edited.items[item.id].sourceVisualReview, undefined);

  const removedOutput = updatePictureChannelAsset(original, {
    itemId: item.id,
    channelId: 'secondary',
    remove: true,
    now: '2026-07-23T20:13:31.000Z'
  });
  assert.equal(removedOutput.items[item.id].sourceVisualReview, undefined);

  const replacementRaw = structuredClone(original);
  const replacementHash = 'c'.repeat(64);
  const replacementAssetId = `sha256:${replacementHash}`;
  replacementRaw.assets[replacementAssetId] = {
    id: replacementAssetId,
    kind: 'image',
    sha256: replacementHash,
    fileName: 'replacement.png',
    storedName: `${replacementHash}.png`,
    mediaType: 'image/png',
    size: 4096,
    createdAt: NOW,
    attribution: '',
    altText: 'Replacement picture',
    width: 1920,
    height: 1080,
    orientation: 1
  };
  const withReplacement = normalizeServiceProject(replacementRaw);
  const replacedOutput = updatePictureChannelAsset(withReplacement, {
    itemId: item.id,
    channelId: 'primary',
    assetId: replacementAssetId,
    now: '2026-07-23T20:13:32.000Z'
  });
  assert.equal(replacedOutput.items[item.id].sourceVisualReview, undefined);

  let sequence = 0;
  const duplicated = duplicateProjectItem(original, {
    itemId: item.id,
    now: '2026-07-23T20:13:33.000Z',
    randomUUID: () =>
      `20000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`
  });
  const copiedItem = duplicated.items[duplicated.rootItemIds[1]];
  assert.equal(copiedItem.kind, 'picture');
  assert.equal(copiedItem.sourceVisualReview, undefined);
  assert.deepEqual(copiedItem.assetIdsByChannel, item.assetIdsByChannel);

  const savedRaw = structuredClone(original);
  savedRaw.revision = 1;
  const planned = planNextServiceProject(normalizeServiceProject(savedRaw), {
    id: 'authoring-service-next',
    title: 'Next service',
    serviceDate: '2026-08-02',
    startTime: '10:30',
    now: '2026-07-23T20:13:34.000Z'
  });
  assert.equal(planned.sourceServiceSet, undefined);
  assert.equal(
    planned.items[item.id].sourceVisualReview,
    undefined,
    'a copied next-service picture cannot retain the previous render review'
  );

  assert.deepEqual(
    original.items[item.id].sourceVisualReview,
    item.sourceVisualReview
  );
});

test('picture outputs migrate from shared routing and safely replace or remove localized images', () => {
  const original = projectWithPicture();
  const raw = structuredClone(original);
  const secondHash = 'e'.repeat(64);
  const secondAssetId = `sha256:${secondHash}`;
  raw.assets[secondAssetId] = {
    id: secondAssetId,
    kind: 'image',
    sha256: secondHash,
    fileName: 'welcome-uk.png',
    storedName: `${secondHash}.png`,
    mediaType: 'image/png',
    size: 4096,
    createdAt: NOW,
    attribution: 'Church archive',
    altText: 'Localized welcome',
    width: 1920,
    height: 1080,
    orientation: 1
  };
  const withSecondAsset = normalizeServiceProject(raw);
  const sharedAssetId = withSecondAsset.items['welcome-picture'].assetId;

  const localized = updatePictureChannelAsset(withSecondAsset, {
    itemId: 'welcome-picture',
    channelId: 'secondary',
    assetId: secondAssetId,
    now: '2026-07-23T20:14:00.000Z'
  });
  assert.deepEqual(localized.items['welcome-picture'].assetIdsByChannel, {
    primary: sharedAssetId,
    secondary: secondAssetId
  });
  assert.equal(localized.items['welcome-picture'].assetId, undefined);
  assert.equal(withSecondAsset.items['welcome-picture'].assetId, sharedAssetId);

  const replaced = updatePictureChannelAsset(localized, {
    itemId: 'welcome-picture',
    channelId: 'primary',
    assetId: secondAssetId,
    now: '2026-07-23T20:15:00.000Z'
  });
  assert.deepEqual(replaced.items['welcome-picture'].assetIdsByChannel, {
    primary: secondAssetId,
    secondary: secondAssetId
  });
  assert.equal(replaced.assets[sharedAssetId], undefined,
    'the displaced shared asset is pruned only after no output references it');

  const hiddenSecondary = updatePictureChannelAsset(replaced, {
    itemId: 'welcome-picture',
    channelId: 'secondary',
    remove: true,
    now: '2026-07-23T20:16:00.000Z'
  });
  assert.deepEqual(hiddenSecondary.items['welcome-picture'].assetIdsByChannel, {
    primary: secondAssetId
  });
  assert.ok(hiddenSecondary.assets[secondAssetId]);

  expectProjectCode('PICTURE_OUTPUT_ALREADY_HIDDEN', () => updatePictureChannelAsset(
    hiddenSecondary,
    {
      itemId: 'welcome-picture',
      channelId: 'secondary',
      remove: true,
      now: NOW
    }
  ));
  expectProjectCode('PICTURE_NEEDS_OUTPUT', () => updatePictureChannelAsset(hiddenSecondary, {
    itemId: 'welcome-picture',
    channelId: 'primary',
    remove: true,
    now: NOW
  }));
  expectProjectCode('INVALID_ASSET_REFERENCE', () => updatePictureChannelAsset(hiddenSecondary, {
    itemId: 'welcome-picture',
    channelId: 'secondary',
    assetId: `sha256:${'f'.repeat(64)}`,
    now: NOW
  }));
});

test('duplicating a subtree creates independent item and arrangement identities while reusing content', () => {
  const original = projectWithSongSubtree();
  const originalResourceJson = JSON.stringify(original.resources);
  let sequence = 0;
  const duplicate = duplicateProjectItem(original, {
    itemId: 'worship',
    now: '2026-07-23T20:15:00.000Z',
    randomUUID: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`
  });

  assert.equal(duplicate.rootItemIds.length, 2);
  assert.equal(duplicate.rootItemIds[0], 'worship');
  const copiedGroupId = duplicate.rootItemIds[1];
  const copiedGroup = duplicate.items[copiedGroupId];
  assert.notEqual(copiedGroupId, 'worship');
  assert.equal(copiedGroup.title, 'Worship copy');
  assert.equal(copiedGroup.childIds.length, 2);
  assert.ok(copiedGroup.childIds.every(itemId => !['song-grace', 'worship-notice'].includes(itemId)));

  const copiedSong = copiedGroup.childIds
    .map(itemId => duplicate.items[itemId])
    .find(item => item.kind === 'song');
  const copiedNotice = copiedGroup.childIds
    .map(itemId => duplicate.items[itemId])
    .find(item => item.kind === 'notice');
  assert.ok(copiedSong);
  assert.ok(copiedNotice);
  assert.deepEqual(
    copiedSong.arrangement.map(entry => entry.sectionId),
    original.items['song-grace'].arrangement.map(entry => entry.sectionId)
  );
  assert.ok(copiedSong.arrangement.every(entry =>
    !original.items['song-grace'].arrangement.some(originalEntry => originalEntry.id === entry.id)));
  assert.equal(
    copiedSong.variants.primary.resourceId,
    original.items['song-grace'].variants.primary.resourceId
  );
  assert.equal(JSON.stringify(duplicate.resources), originalResourceJson);
  assert.deepEqual(duplicate.assets, original.assets);
  assert.equal(original.rootItemIds.length, 1);
  assert.equal(original.items.worship.title, 'Worship');

  const timeline = compileServiceProject(duplicate);
  const originalCueIds = timeline.cueIds.filter(cueId =>
    ['song-grace', 'worship-notice'].includes(timeline.cues[cueId].itemId));
  const copiedCueIds = timeline.cueIds.filter(cueId =>
    copiedGroup.childIds.includes(timeline.cues[cueId].itemId));
  assert.equal(originalCueIds.length, copiedCueIds.length);
  assert.equal(originalCueIds.some(cueId => copiedCueIds.includes(cueId)), false);
  assert.ok(Object.isFrozen(duplicate));
});

test('single-leaf duplication defaults immediately after the source and validates its destination', () => {
  const original = projectWithSermon();
  let sequence = 0;
  const duplicate = duplicateProjectItem(original, {
    itemId: 'sermon-point-one',
    now: NOW,
    randomUUID: () => `10000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`
  });
  const children = duplicate.items['sermon-outline'].childIds;

  assert.equal(children[0], 'sermon-point-one');
  assert.equal(children.length, 2);
  assert.equal(duplicate.items[children[1]].title, 'First point copy');
  expectProjectCode('INVALID_PARENT', () => duplicateProjectItem(original, {
    itemId: 'sermon-point-one',
    targetParentId: 'sermon-point-one',
    now: NOW
  }));
});
