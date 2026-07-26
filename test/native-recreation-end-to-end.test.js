'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');

const {
  NATIVE_RENDERER_VERSION,
  LocalSongLibrary,
  ServiceProjectExchange,
  ServiceProjectStore,
  ShowPackagePublisher,
  addGroupItem,
  addProjectItem,
  addSongResource,
  compileServiceProject,
  inspectZipStructure,
  parseSongDocument,
  updatePictureChannelAsset,
  updateTextItem
} = require('../src/services/project');

const FONT_PATH = path.resolve(__dirname, '../assets/fonts/NotoSans-Variable.ttf');
const NOW = '2026-07-23T20:00:00.000Z';
const CHANNEL_IDS = Object.freeze(['primary', 'secondary', 'media']);

async function tempDirectory(t, prefix) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return fs.realpath(directory);
}

function sourceSong(line = 'Grace builds the church') {
  return [
    '---',
    'id: native-church-song',
    'title: Native Church Song',
    'language: en',
    'authors: Test Author',
    'composers: Test Composer',
    '---',
    '^1',
    line,
    'The church displays the wisdom of God'
  ].join('\n');
}

function goldSpan(text, value) {
  const start = text.indexOf(value);
  assert.notEqual(start, -1, `expected ${JSON.stringify(value)} in ${JSON.stringify(text)}`);
  return [{
    start,
    end: start + value.length,
    foreground: '#ffc000'
  }];
}

function auditTimeline(project) {
  const timeline = compileServiceProject(project);
  const blockTypes = [];
  const imageBlocks = [];
  for (const cueId of timeline.cueIds) {
    const cue = timeline.cues[cueId];
    assert.deepEqual(Object.keys(cue.channels).sort(), [...CHANNEL_IDS].sort());
    for (const [channelId, channel] of Object.entries(cue.channels)) {
      for (const block of channel.blocks || []) {
        blockTypes.push(block.type);
        if (block.type === 'image') imageBlocks.push({ cueId, channelId, assetId: block.assetId });
      }
    }
  }
  return { timeline, blockTypes, imageBlocks };
}

test('a service recreated from scratch stays native, editable, portable, and publishable', async t => {
  const sourceRoot = await tempDirectory(t, 'syncshow-native-recreation-source-');
  const sourceImageRoot = await tempDirectory(t, 'syncshow-native-recreation-images-');
  const sourceStore = new ServiceProjectStore({
    rootPath: path.join(sourceRoot, 'projects'),
    clock: () => new Date(NOW)
  });
  const sourceLibrary = new LocalSongLibrary({
    rootPath: path.join(sourceRoot, 'songs'),
    clock: () => new Date(NOW)
  });

  const savedSong = await sourceLibrary.saveSource(sourceSong(), {
    fileName: 'native-church-song.md',
    expectedRevision: null
  });
  const created = await sourceStore.create({
    id: 'native-recreation-service',
    title: 'Native Recreation Service',
    serviceDate: '2026-07-26',
    profileId: 'native-recreation-profile',
    channels: [
      { id: 'primary', label: 'Russian', language: 'ru' },
      { id: 'secondary', label: 'English', language: 'en' },
      { id: 'media', label: 'Singers', language: 'ru' }
    ]
  });

  let project = addGroupItem(created.project, {
    id: 'service',
    title: 'Service',
    groupKind: 'service',
    now: NOW
  });
  project = addGroupItem(project, {
    id: 'worship',
    title: 'Worship',
    groupKind: 'section',
    parentId: 'service',
    now: NOW
  });
  project = addGroupItem(project, {
    id: 'reading',
    title: 'Reading',
    groupKind: 'section',
    parentId: 'service',
    now: NOW
  });
  project = addGroupItem(project, {
    id: 'sermon',
    title: 'Sermon',
    groupKind: 'sermon',
    parentId: 'service',
    now: NOW
  });
  project = addGroupItem(project, {
    id: 'sermon-point-one',
    title: 'I. The Wisdom of God',
    groupKind: 'point',
    parentId: 'sermon',
    now: NOW
  });

  const pinnedSong = addSongResource(project, savedSong.song, {
    provider: 'local',
    itemId: savedSong.song.id,
    revision: savedSong.revision
  });
  project = addProjectItem(pinnedSong.project, {
    id: 'service-song',
    kind: 'song',
    title: savedSong.song.title,
    primaryChannelId: 'primary',
    variants: {
      primary: { mode: 'content', resourceId: pinnedSong.resourceId },
      secondary: { mode: 'inherit', from: 'primary' },
      media: {
        mode: 'derive',
        from: 'primary',
        transform: { id: 'first-lines', version: 1, maxLines: 2 }
      }
    },
    arrangement: [{ id: 'song-verse-one', sectionId: 'verse-1' }],
    titlePresetId: 'song-title',
    lyricsPresetId: 'song-lyrics',
    operatorNotes: ''
  }, {
    parentId: 'worship',
    now: NOW
  });

  const sermonText = {
    primary: 'Еф.3:10 Божья мудрость открывается через Церковь.',
    secondary: 'Eph.3:10 God’s wisdom is made known through the church.',
    media: 'Еф.3:10 Божья мудрость открывается через Церковь.'
  };
  project = addProjectItem(project, {
    id: 'sermon-text',
    kind: 'sermon',
    title: 'The Wisdom of God',
    titlesByChannel: {
      primary: 'I. Мудрость Божья',
      secondary: 'I. The Wisdom of God',
      media: 'I. Мудрость Божья'
    },
    textByChannel: sermonText,
    spansByChannel: {
      primary: goldSpan(sermonText.primary, 'Еф.3:10'),
      secondary: goldSpan(sermonText.secondary, 'Eph.3:10'),
      media: goldSpan(sermonText.media, 'Еф.3:10')
    },
    presetId: 'sermon-notes',
    operatorNotes: 'Native editable sermon cue.'
  }, {
    parentId: 'sermon-point-one',
    now: NOW
  });

  project = addProjectItem(project, {
    id: 'reading-text',
    kind: 'notice',
    title: 'Ephesians Reading',
    titlesByChannel: {
      primary: 'Ефесянам 3',
      secondary: 'Ephesians 3',
      media: 'Ефесянам 3'
    },
    textByChannel: {
      primary: 'Церковь открывает многоразличную мудрость Божью.',
      secondary: 'The church makes known the manifold wisdom of God.',
      media: 'Церковь открывает многоразличную мудрость Божью.'
    },
    presetId: 'notice-text',
    operatorNotes: 'Faithful native reading text.'
  }, {
    parentId: 'reading',
    now: NOW
  });
  project = addProjectItem(project, {
    id: 'service-blank',
    kind: 'blank',
    title: 'Intentional blank',
    channelIds: [...CHANNEL_IDS],
    presetId: 'blank-black',
    operatorNotes: ''
  }, {
    parentId: 'service',
    now: NOW
  });

  const semanticRevision = await sourceStore.save(project, {
    expectedRevisionId: created.revisionId,
    reason: 'native-semantic-content'
  });

  const russianImagePath = path.join(sourceImageRoot, 'welcome-russian.png');
  const englishImagePath = path.join(sourceImageRoot, 'welcome-english.png');
  await Promise.all([
    sharp({
      create: {
        width: 64,
        height: 36,
        channels: 3,
        background: '#1f3f74'
      }
    }).png().toFile(russianImagePath),
    sharp({
      create: {
        width: 64,
        height: 36,
        channels: 3,
        background: '#743f1f'
      }
    }).png().toFile(englishImagePath)
  ]);

  const withPicture = await sourceStore.importImageAndUpdateProject(
    semanticRevision.project.id,
    {
      sourcePath: russianImagePath,
      expectedRevisionId: semanticRevision.revisionId,
      altText: 'Localized welcome artwork',
      attribution: 'Native recreation fixture',
      reason: 'add-native-picture'
    },
    (currentProject, asset) => addProjectItem(currentProject, {
      id: 'localized-picture',
      kind: 'picture',
      title: 'Welcome',
      assetId: asset.id,
      channelIds: [...CHANNEL_IDS],
      fit: 'fit',
      focalPoint: { x: 0.5, y: 0.5 },
      altText: asset.altText,
      attribution: asset.attribution,
      presetId: 'picture-fullscreen',
      operatorNotes: 'Only intentional artwork remains rasterized.'
    }, {
      parentId: 'service',
      now: NOW
    })
  );
  const localizedRevision = await sourceStore.importImageAndUpdateProject(
    withPicture.project.id,
    {
      sourcePath: englishImagePath,
      expectedRevisionId: withPicture.revisionId,
      altText: 'Localized welcome artwork',
      attribution: 'Native recreation fixture',
      reason: 'localize-native-picture'
    },
    (currentProject, asset) => updatePictureChannelAsset(currentProject, {
      itemId: 'localized-picture',
      channelId: 'secondary',
      assetId: asset.id,
      now: NOW
    })
  );

  assert.deepEqual(localizedRevision.project.rootItemIds, ['service']);
  assert.deepEqual(localizedRevision.project.items.service.childIds, [
    'worship',
    'reading',
    'sermon',
    'service-blank',
    'localized-picture'
  ]);
  assert.deepEqual(localizedRevision.project.items.sermon.childIds, ['sermon-point-one']);
  assert.deepEqual(localizedRevision.project.items['sermon-point-one'].childIds, ['sermon-text']);
  assert.equal(Object.keys(localizedRevision.project.assets).length, 2);
  assert.equal(
    localizedRevision.project.items['localized-picture'].assetIdsByChannel.primary,
    localizedRevision.project.items['localized-picture'].assetIdsByChannel.media
  );
  assert.notEqual(
    localizedRevision.project.items['localized-picture'].assetIdsByChannel.primary,
    localizedRevision.project.items['localized-picture'].assetIdsByChannel.secondary
  );

  const sourceAudit = auditTimeline(localizedRevision.project);
  assert.equal(sourceAudit.timeline.cueIds.length, 6);
  assert.equal(sourceAudit.imageBlocks.length, 3);
  assert.equal(sourceAudit.blockTypes.includes('legacy-deck'), false);
  assert.equal(Object.values(localizedRevision.project.items)
    .some(item => item.kind === 'imported-deck'), false);
  assert.doesNotMatch(JSON.stringify(localizedRevision.project), /\.pptx|legacy-deck/i);

  const sourcePublisher = new ShowPackagePublisher({
    projectStore: sourceStore,
    rootPath: path.join(sourceRoot, 'packages'),
    fontPath: FONT_PATH,
    clock: () => new Date(NOW)
  });
  const publishOptions = {
    projectId: localizedRevision.project.id,
    revisionId: localizedRevision.revisionId,
    roleMapping: {
      russian: 'primary',
      english: 'secondary',
      singers: 'media'
    },
    width: 640,
    height: 360,
    thumbnailWidth: 100,
    jpegQuality: 82
  };
  const firstPublished = await sourcePublisher.publish(publishOptions);
  assert.equal(firstPublished.manifest.rendererVersion, NATIVE_RENDERER_VERSION);
  assert.deepEqual(
    Object.values(firstPublished.presentations).map(presentation => presentation.slideCount),
    [6, 6, 6]
  );
  assert.equal(
    Object.values(firstPublished.presentations)
      .every(presentation => presentation.sourceType === 'service-project'),
    true
  );
  const pictureCueNumber = sourceAudit.timeline.cueIds.findIndex(cueId =>
    sourceAudit.timeline.cues[cueId].kind === 'picture') + 1;
  const pictureCueIndex = pictureCueNumber - 1;
  const russianPicture = firstPublished.presentations.russian.scenes[pictureCueIndex];
  const englishPicture = firstPublished.presentations.english.scenes[pictureCueIndex];
  const singerPicture = firstPublished.presentations.singers.scenes[pictureCueIndex];
  assert.equal(russianPicture.layout, 'picture');
  assert.equal(englishPicture.layout, 'picture');
  assert.equal(singerPicture.layout, 'picture');
  assert.notEqual(russianPicture.picture.assetId, englishPicture.picture.assetId);
  assert.equal(russianPicture.picture.assetId, singerPicture.picture.assetId);
  assert.equal(
    await fs.readFile(firstPublished.presentations.russian.assetPaths[
      russianPicture.picture.assetId
    ], 'base64'),
    await fs.readFile(firstPublished.presentations.singers.assetPaths[
      singerPicture.picture.assetId
    ], 'base64')
  );

  const exported = await new ServiceProjectExchange({
    projectStore: sourceStore,
    appVersion: '1.4.0-native-recreation-test'
  }).exportBundle(localizedRevision.project.id, localizedRevision.revisionId);
  assert.equal(exported.assetCount, 2);
  const bundleEntries = [...inspectZipStructure(exported.buffer).keys()];
  assert.deepEqual(bundleEntries.slice(0, 2), ['manifest.json', 'project.json']);
  assert.equal(bundleEntries.length, 4);
  assert.equal(bundleEntries.slice(2).every(name => /^assets\/[a-f0-9]{64}\.png$/.test(name)), true);
  assert.equal(bundleEntries.some(name => /\.pptx|\.jpe?g$/i.test(name)), false);

  const targetRoot = await tempDirectory(t, 'syncshow-native-recreation-target-');
  const targetStore = new ServiceProjectStore({
    rootPath: path.join(targetRoot, 'projects'),
    clock: () => new Date(NOW)
  });
  const targetLibrary = new LocalSongLibrary({
    rootPath: path.join(targetRoot, 'songs'),
    clock: () => new Date(NOW)
  });
  const targetExchange = new ServiceProjectExchange({
    projectStore: targetStore,
    songLibrary: targetLibrary,
    appVersion: '1.4.0-native-recreation-test'
  });
  const imported = await targetExchange.importBundle(exported.buffer);
  assert.equal(imported.imported, true);
  assert.equal(imported.forked, false);
  assert.deepEqual(imported.songLibrary, {
    available: true,
    discovered: 1,
    added: 1,
    unchanged: 0,
    conflicts: 0,
    failed: 0,
    warnings: [],
    omittedWarnings: 0
  });
  const importedAudit = auditTimeline(imported.project);
  assert.deepEqual(importedAudit.timeline.cueIds, sourceAudit.timeline.cueIds);
  assert.equal(importedAudit.blockTypes.includes('legacy-deck'), false);
  assert.equal(importedAudit.imageBlocks.length, 3);

  const editableSong = await targetLibrary.read('native-church-song');
  const editedSong = await targetLibrary.saveSource(
    sourceSong('Grace builds the edited church'),
    {
      fileName: 'native-church-song.md',
      expectedSongId: editableSong.song.id,
      expectedRevision: editableSong.revision
    }
  );
  assert.notEqual(editedSong.revision, editableSong.revision);
  assert.equal(editedSong.song.sections[0].slides[0].lines[0], 'Grace builds the edited church');
  const pinnedImportedSong = Object.values(imported.project.resources)
    .find(resource => resource.document.id === editableSong.song.id);
  assert.equal(
    pinnedImportedSong.document.sections[0].slides[0].lines[0],
    'Grace builds the church',
    'editing the library must not silently rewrite an already pinned service'
  );

  const importedSermon = imported.project.items['sermon-text'];
  const editedPrimaryText = 'Eph.3:11 This editable emphasis survives a clean import.';
  const editedProject = updateTextItem(imported.project, {
    itemId: importedSermon.id,
    textByChannel: {
      ...importedSermon.textByChannel,
      primary: editedPrimaryText
    },
    spansByChannel: {
      ...importedSermon.spansByChannel,
      primary: goldSpan(editedPrimaryText, 'editable emphasis')
    },
    now: NOW
  });
  const editedRevision = await targetStore.save(editedProject, {
    expectedRevisionId: imported.revisionId,
    reason: 'edit-imported-sermon'
  });
  const editedAudit = auditTimeline(editedRevision.project);
  assert.equal(editedAudit.blockTypes.includes('legacy-deck'), false);
  const editedSermonCue = Object.values(editedAudit.timeline.cues)
    .find(cue => cue.itemId === importedSermon.id);
  const editedBody = editedSermonCue.channels.primary.blocks
    .find(block => block.role === 'body');
  assert.equal(editedBody.text, editedPrimaryText);
  assert.deepEqual(
    editedBody.spans,
    goldSpan(editedPrimaryText, 'editable emphasis')
  );

  const targetPublisher = new ShowPackagePublisher({
    projectStore: targetStore,
    rootPath: path.join(targetRoot, 'packages'),
    fontPath: FONT_PATH,
    clock: () => new Date(NOW)
  });
  const republished = await targetPublisher.publish({
    ...publishOptions,
    revisionId: editedRevision.revisionId
  });
  assert.equal(republished.manifest.rendererVersion, NATIVE_RENDERER_VERSION);
  assert.deepEqual(
    Object.values(republished.presentations).map(presentation => presentation.slideCount),
    [6, 6, 6]
  );
  assert.equal(
    republished.presentations.russian.metadata.slides
      .some(slide => slide.text.includes('editable emphasis')),
    true
  );

  const manifestPath = path.join(republished.packagePath, 'manifest.json');
  const forgedManifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  assert.ok(forgedManifest.assets.length > 0);
  forgedManifest.assets[0].size += 1;
  await fs.writeFile(manifestPath, `${JSON.stringify(forgedManifest, null, 2)}\n`);
  await assert.rejects(
    targetPublisher.publish({
      ...publishOptions,
      revisionId: editedRevision.revisionId
    }),
    error => {
      assert.equal(error.code, 'SHOW_PACKAGE_CORRUPT');
      return true;
    }
  );
});
