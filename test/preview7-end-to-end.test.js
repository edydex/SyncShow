'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  ProjectStoreError,
  ServiceProjectStore,
  ShowPackagePublisher,
  addBibleItem,
  addGroupItem,
  addProjectItem,
  addSongResource,
  compileServiceProject,
  linkSongTranslation,
  moveProjectItem,
  parseSongDocument,
  updateSongArrangement
} = require('../src/services/project');

const FONT_PATH = path.resolve(__dirname, '../assets/fonts/NotoSans-Variable.ttf');
const START = '2026-07-23T19:00:00.000Z';

async function tempDirectory(t, prefix) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return fs.realpath(directory);
}

function expectStoreCode(code) {
  return error => {
    assert.ok(error instanceof ProjectStoreError, `expected ProjectStoreError, got ${error?.constructor?.name}`);
    assert.equal(error.code, code);
    return true;
  };
}

function sourceSong() {
  return parseSongDocument([
    '---',
    'id: living-hope',
    'title: Living Hope',
    'language: en',
    '---',
    '^1',
    'How great the chasm',
    '^chorus',
    'Hallelujah, praise the One who set me free',
    '---',
    'Jesus Christ, my living hope'
  ].join('\n'));
}

function translatedSong() {
  return parseSongDocument([
    '---',
    'id: living-hope-uk',
    'title: Жива надія',
    'language: uk',
    'translationOf: living-hope',
    '---',
    '^1',
    'Яка велика прірва',
    '^chorus',
    'Алілуя, Ти звільнив мене',
    '---',
    'Ісус Христос, моя жива надія'
  ].join('\n'));
}

function pinnedPassage(translationId, texts, attribution) {
  return {
    translation: {
      id: translationId,
      attribution,
      suggestedCredit: `${translationId} source credit`
    },
    book: 'John',
    chapter: 3,
    verseStart: 16,
    verseEnd: 17,
    reference: 'John 3:16–17',
    verses: texts.map((text, index) => ({ number: 16 + index, text }))
  };
}

test('Preview 7 authoring survives CAS revisions and restart, then publishes a verified equal-channel native Show package', async t => {
  const workspace = await tempDirectory(t, 'syncshow-preview7-e2e-');
  const projectsPath = path.join(workspace, 'projects');
  const packagesPath = path.join(workspace, 'packages');
  let clockValue = new Date(START);
  const clock = () => new Date(clockValue);
  const advance = () => {
    clockValue = new Date(clockValue.getTime() + 60 * 1000);
    return clock().toISOString();
  };
  const store = new ServiceProjectStore({ rootPath: projectsPath, clock });

  const created = await store.create({
    id: 'preview-seven-e2e',
    title: 'Preview Seven End to End',
    serviceDate: '2026-07-26',
    profileId: 'main-sanctuary',
    channels: [
      { id: 'primary', label: 'English', language: 'en' },
      { id: 'secondary', label: 'Ukrainian', language: 'uk' },
      { id: 'media', label: 'Singers', language: 'en' }
    ]
  });

  const grouped = addGroupItem(created.project, {
    id: 'worship',
    title: 'Worship',
    groupKind: 'section',
    now: advance()
  });
  const groupRevision = await store.save(grouped, {
    expectedRevisionId: created.revisionId,
    reason: 'preview7-add-group'
  });

  const source = addSongResource(groupRevision.project, sourceSong(), {
    provider: 'local',
    itemId: 'living-hope',
    revision: 'source-revision-1'
  });
  const songDraft = addProjectItem(source.project, {
    id: 'song-living-hope',
    kind: 'song',
    title: 'Living Hope',
    variants: {
      primary: { mode: 'content', resourceId: source.resourceId },
      secondary: { mode: 'inherit', from: 'primary' },
      media: {
        mode: 'derive',
        from: 'primary',
        transform: { id: 'first-lines', version: 1, maxLines: 2 }
      }
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
    now: advance()
  });
  const songRevision = await store.save(songDraft, {
    expectedRevisionId: groupRevision.revisionId,
    reason: 'preview7-add-song'
  });

  const arranged = updateSongArrangement(songRevision.project, {
    itemId: 'song-living-hope',
    arrangement: [
      { id: 'arr-chorus-one', sectionId: 'chorus' },
      { id: 'arr-verse-one', sectionId: 'verse-1' },
      { id: 'arr-chorus-two', sectionId: 'chorus' }
    ],
    now: advance()
  });
  const arrangementRevision = await store.save(arranged, {
    expectedRevisionId: songRevision.revisionId,
    reason: 'preview7-arrange-song'
  });

  const translated = linkSongTranslation(arrangementRevision.project, {
    itemId: 'song-living-hope',
    channelId: 'secondary',
    song: translatedSong(),
    origin: {
      provider: 'local',
      itemId: 'living-hope-uk',
      revision: 'translation-revision-1'
    },
    now: advance()
  });
  const translationRevision = await store.save(translated, {
    expectedRevisionId: arrangementRevision.revisionId,
    reason: 'preview7-link-translation'
  });

  const withBible = addBibleItem(translationRevision.project, {
    id: 'bible-john-3-16',
    title: 'John 3:16–17',
    passagesByChannel: {
      primary: pinnedPassage('BSB', [
        'For God so loved the world that He gave His one and only Son.',
        'For God did not send His Son into the world to condemn the world.'
      ], null),
      secondary: pinnedPassage('LSV', [
        'For God so loved the world that He gave His only begotten Son.',
        'For God did not send His Son into the world that He may judge the world.'
      ], 'Literal Standard Version attribution')
    },
    now: advance()
  });
  const bibleRevision = await store.save(withBible, {
    expectedRevisionId: translationRevision.revisionId,
    reason: 'preview7-pin-bible'
  });
  assert.deepEqual(bibleRevision.project.rootItemIds, ['worship', 'bible-john-3-16']);

  const nested = moveProjectItem(bibleRevision.project, {
    itemId: 'bible-john-3-16',
    targetParentId: 'worship',
    targetIndex: 1
  });
  const finalRevision = await store.save(nested, {
    expectedRevisionId: bibleRevision.revisionId,
    reason: 'preview7-nest-bible'
  });
  assert.deepEqual(finalRevision.project.items.worship.childIds, [
    'song-living-hope',
    'bible-john-3-16'
  ]);

  const staleDraft = addGroupItem(bibleRevision.project, {
    id: 'stale-editor-section',
    title: 'Stale editor section',
    now: advance()
  });
  await assert.rejects(
    store.save(staleDraft, {
      expectedRevisionId: bibleRevision.revisionId,
      reason: 'stale-editor'
    }),
    expectStoreCode('PROJECT_CONFLICT')
  );
  assert.equal((await store.read(created.project.id)).revisionId, finalRevision.revisionId);

  const restartedStore = new ServiceProjectStore({ rootPath: projectsPath });
  const exact = await restartedStore.read(created.project.id, {
    revisionId: finalRevision.revisionId
  });
  const current = await restartedStore.read(created.project.id);
  assert.deepEqual(exact.project, finalRevision.project);
  assert.deepEqual(current.project, finalRevision.project);
  assert.equal(current.revisionId, finalRevision.revisionId);

  const historicalArrangement = await restartedStore.read(created.project.id, {
    revisionId: arrangementRevision.revisionId
  });
  assert.equal(
    historicalArrangement.project.items['song-living-hope'].variants.secondary.mode,
    'inherit',
    'an exact historical revision must remain unchanged after linking a translation'
  );

  const timeline = compileServiceProject(exact.project);
  assert.equal(timeline.cueIds.length, 7);
  assert.equal(new Set(timeline.cueIds).size, 7);
  assert.deepEqual(
    timeline.cueIds.map(cueId => timeline.cues[cueId].groupPath[0]),
    Array(7).fill('Worship')
  );
  assert.deepEqual(
    timeline.cueIds.slice(0, 6).map(cueId => timeline.cues[cueId].sourceReference.sectionId),
    [null, 'chorus', 'chorus', 'verse-1', 'chorus', 'chorus']
  );

  const publisher = new ShowPackagePublisher({
    projectStore: restartedStore,
    rootPath: packagesPath,
    fontPath: FONT_PATH,
    clock: () => new Date('2026-07-23T20:00:00.000Z'),
    randomUUID: () => '77777777-7777-4777-8777-777777777777'
  });
  const publishOptions = {
    projectId: exact.project.id,
    revisionId: exact.revisionId,
    roleMapping: {
      auditorium: 'primary',
      translated: 'secondary',
      singers: 'media'
    },
    width: 640,
    height: 360,
    thumbnailWidth: 100,
    jpegQuality: 82
  };
  const progress = [];
  const published = await publisher.publish({
    ...publishOptions,
    onProgress: update => progress.push(update)
  });

  assert.equal(published.manifest.cueCount, timeline.cueIds.length);
  assert.deepEqual(published.manifest.cueIds, timeline.cueIds);
  assert.equal(published.manifest.channels.length, 3);
  assert.equal(published.manifest.artifacts.length, 46);
  assert.equal(progress.length, 21);
  assert.deepEqual(Object.values(published.presentations).map(item => item.slideCount), [7, 7, 7]);
  assert.equal(
    published.presentations.translated.metadata.slides[1].text,
    'Алілуя, Ти звільнив мене'
  );
  assert.equal(
    published.presentations.auditorium.metadata.slides.at(-1).kind,
    'bible'
  );
  assert.equal(
    published.presentations.singers.metadata.slides.at(-1).text,
    '',
    'a hidden Bible channel still receives an equal-length blank slide'
  );

  const firstThumbnail = path.join(
    published.presentations.auditorium.cacheDir,
    'slide_001_thumb.jpg'
  );
  const jpegMagic = await fs.readFile(firstThumbnail);
  assert.deepEqual([...jpegMagic.subarray(0, 3)], [0xff, 0xd8, 0xff]);
  assert.equal(
    published.presentations.auditorium.scenes[0].cueId,
    timeline.cueIds[0]
  );
  assert.equal(
    (await fs.readdir(published.presentations.auditorium.cacheDir))
      .some(fileName => /^slide_\d+\.jpg$/.test(fileName)),
    false,
    'native output keeps raster thumbnails but no full-size slide images'
  );

  const verifiedAgain = await publisher.publish(publishOptions);
  assert.equal(verifiedAgain.packagePath, published.packagePath);
  assert.deepEqual(verifiedAgain.manifest, published.manifest);
  assert.deepEqual(verifiedAgain.presentations, published.presentations);
});
