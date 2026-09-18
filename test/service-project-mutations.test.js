'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ServiceProjectError,
  addBibleItem,
  addGroupItem,
  addProjectItem,
  addSongResource,
  compareSongTranslations,
  compileServiceProject,
  createDefaultSongChannelVariants,
  createServiceProject,
  linkSongTranslation,
  normalizeServiceProject,
  parseSongDocument,
  resolveAuthoritativeSongSource,
  resetSongChannelVariant,
  serializeServiceProject,
  setSongChannelTreatment,
  updateSongArrangement,
  validateProjectTree
} = require('../src/services/project');

const NOW = '2026-07-23T18:00:00.000Z';

function expectProjectCode(code, callback) {
  assert.throws(callback, error => {
    assert.ok(error instanceof ServiceProjectError, `expected ServiceProjectError, got ${error?.constructor?.name}`);
    assert.equal(error.code, code);
    return true;
  });
}

function freshProject() {
  return createServiceProject({
    id: 'preview-seven-service',
    title: 'Preview Seven Service',
    serviceDate: '2026-07-26',
    profileId: 'main-sanctuary',
    now: NOW,
    channels: [
      { id: 'primary', label: 'Main', language: 'en' },
      { id: 'secondary', label: 'Second language', language: 'uk' },
      { id: 'media', label: 'Singers', language: 'en' }
    ]
  });
}

function primarySong() {
  return parseSongDocument([
    '---',
    'id: steadfast-love',
    'title: Steadfast Love',
    'language: en',
    '---',
    '^1',
    'Morning by morning',
    '^chorus',
    'Great is Your faithfulness',
    '---',
    'Your mercies are new'
  ].join('\n'));
}

function translatedSong(options = {}) {
  return parseSongDocument([
    '---',
    `id: ${options.id || 'steadfast-love-uk'}`,
    `title: ${options.title || 'Вірна любов'}`,
    'language: uk',
    `translationOf: ${options.translationOf || 'steadfast-love'}`,
    '---',
    '^1',
    'Щоранку знову',
    '^chorus',
    'Велика вірність Твоя',
    ...(options.aligned === false ? [] : ['---', 'Нове милосердя'])
  ].join('\n'));
}

function projectWithSong() {
  let project = freshProject();
  const pinned = addSongResource(project, primarySong(), {
    provider: 'local',
    itemId: 'steadfast-love',
    revision: 'song-revision-1'
  });
  project = pinned.project;
  project = addProjectItem(project, {
    id: 'song-steadfast-love',
    kind: 'song',
    title: 'Steadfast Love',
    variants: {
      primary: { mode: 'content', resourceId: pinned.resourceId },
      secondary: { mode: 'inherit', from: 'primary' },
      media: {
        mode: 'derive',
        from: 'primary',
        transform: { id: 'first-lines', version: 1, maxLines: 2 }
      }
    },
    arrangement: [
      { id: 'arr-verse-one', sectionId: 'verse-1' },
      { id: 'arr-chorus-one', sectionId: 'chorus' },
      { id: 'arr-chorus-two', sectionId: 'chorus' }
    ],
    titlePresetId: 'song-title',
    lyricsPresetId: 'song-lyrics',
    operatorNotes: ''
  }, { now: NOW });
  return project;
}

function biblePassage(options = {}) {
  const verseStart = options.verseStart || 16;
  const verseEnd = options.verseEnd || 17;
  const translationId = options.translationId || 'BSB';
  return {
    translation: {
      id: translationId,
      suggestedCredit: options.credit || `${translationId} pinned source credit`,
      attribution: options.attribution || null
    },
    book: options.book || 'John',
    chapter: options.chapter || 3,
    verseStart,
    verseEnd,
    reference: options.reference || `John 3:${verseStart}–${verseEnd}`,
    verses: Array.from({ length: verseEnd - verseStart + 1 }, (_, index) => ({
      number: verseStart + index,
      text: `${translationId} pinned verse ${verseStart + index}`
    }))
  };
}

test('new-song defaults use primary-or-first channel identity and never infer from custom labels', () => {
  let custom = createServiceProject({
    id: 'custom-output-service',
    title: 'Custom output service',
    serviceDate: '2026-07-26',
    profileId: 'custom-sanctuary',
    now: NOW,
    channels: [
      { id: 'confidence', label: 'Choir confidence', language: 'en' },
      { id: 'broadcast', label: 'Media Singer Stage', language: 'en' },
      { id: 'room', label: 'Room screen', language: 'en' }
    ]
  });
  const customPinned = addSongResource(custom, primarySong());
  custom = customPinned.project;
  assert.deepEqual(
    createDefaultSongChannelVariants(custom, customPinned.resourceId),
    {
      sourceChannelId: 'confidence',
      variants: {
        confidence: {
          mode: 'content',
          resourceId: customPinned.resourceId
        },
        broadcast: { mode: 'inherit', from: 'confidence' },
        room: { mode: 'inherit', from: 'confidence' }
      }
    }
  );

  let withPrimary = createServiceProject({
    id: 'explicit-primary-service',
    title: 'Explicit primary service',
    serviceDate: '2026-07-26',
    profileId: 'custom-sanctuary',
    now: NOW,
    channels: [
      { id: 'stage-first', label: 'Stage first', language: 'en' },
      { id: 'primary', label: 'Ordinary room output', language: 'en' }
    ]
  });
  const primaryPinned = addSongResource(withPrimary, primarySong());
  withPrimary = primaryPinned.project;
  assert.deepEqual(
    createDefaultSongChannelVariants(withPrimary, primaryPinned.resourceId),
    {
      sourceChannelId: 'primary',
      variants: {
        'stage-first': { mode: 'inherit', from: 'primary' },
        primary: {
          mode: 'content',
          resourceId: primaryPinned.resourceId
        }
      }
    }
  );
});

test('addGroupItem creates only empty groups and preserves the semantic tree invariants', () => {
  let project = addGroupItem(freshProject(), {
    id: 'worship',
    title: 'Worship',
    groupKind: 'section',
    now: NOW
  });
  project = addGroupItem(project, {
    id: 'opening-songs',
    title: 'Opening songs',
    groupKind: 'custom',
    parentId: 'worship',
    index: 0,
    now: NOW
  });

  assert.deepEqual(project.rootItemIds, ['worship']);
  assert.deepEqual(project.items.worship.childIds, ['opening-songs']);
  assert.deepEqual(project.items['opening-songs'].childIds, []);
  assert.equal(validateProjectTree(project).parentByItemId['opening-songs'], 'worship');
  assert.ok(Object.isFrozen(project));
  assert.ok(Object.isFrozen(project.items.worship));

  expectProjectCode('INVALID_NEW_GROUP_CHILDREN', () => addGroupItem(project, {
    id: 'unsafe-group',
    title: 'Unsafe',
    childIds: ['opening-songs'],
    now: NOW
  }));

  const corrupted = JSON.parse(serializeServiceProject(project));
  corrupted.items.orphan = {
    id: 'orphan',
    kind: 'group',
    title: 'Orphan',
    groupKind: 'section',
    childIds: [],
    operatorNotes: '',
    createdAt: NOW,
    updatedAt: NOW
  };
  expectProjectCode('ORPHAN_PROJECT_ITEMS', () => addGroupItem(corrupted, {
    id: 'another-group',
    title: 'Another',
    now: NOW
  }));
});

test('updateSongArrangement retains caller-supplied identities and validates every section against primary content', () => {
  const original = projectWithSong();
  const originalTimeline = compileServiceProject(original);
  assert.equal(
    originalTimeline.cues[originalTimeline.cueIds[0]].channels.media.sourceChannelId,
    'primary',
    'compiled Singer cues retain the full-text source needed for current-plus-next rendering'
  );
  const reorderedEntries = [
    { id: 'arr-chorus-two', sectionId: 'chorus' },
    { id: 'arr-verse-one', sectionId: 'verse-1' },
    { id: 'arr-chorus-one', sectionId: 'chorus' }
  ];
  const updated = updateSongArrangement(original, {
    itemId: 'song-steadfast-love',
    arrangement: reorderedEntries,
    now: '2026-07-23T18:05:00.000Z'
  });
  const updatedTimeline = compileServiceProject(updated);

  assert.deepEqual(updated.items['song-steadfast-love'].arrangement, reorderedEntries);
  assert.deepEqual(
    new Set(updatedTimeline.cueIds),
    new Set(originalTimeline.cueIds),
    'reordering stable entries must retain the compiled cue identity set'
  );
  assert.notDeepEqual(updatedTimeline.cueIds, originalTimeline.cueIds);
  assert.deepEqual(
    original.items['song-steadfast-love'].arrangement.map(entry => entry.id),
    ['arr-verse-one', 'arr-chorus-one', 'arr-chorus-two'],
    'the frozen input project must remain unchanged'
  );

  expectProjectCode('UNKNOWN_ARRANGEMENT_SECTION', () => updateSongArrangement(original, {
    itemId: 'song-steadfast-love',
    arrangement: [{ id: 'arr-bridge', sectionId: 'bridge' }],
    now: NOW
  }));
  expectProjectCode('DUPLICATE_ARRANGEMENT_ID', () => updateSongArrangement(original, {
    itemId: 'song-steadfast-love',
    arrangement: [
      { id: 'same-entry', sectionId: 'verse-1' },
      { id: 'same-entry', sectionId: 'chorus' }
    ],
    now: NOW
  }));
});

test('linkSongTranslation pins only related, slide-aligned documents and compiles the linked channel', () => {
  const original = projectWithSong();
  const resourceCount = Object.keys(original.resources).length;
  const linked = linkSongTranslation(original, {
    itemId: 'song-steadfast-love',
    channelId: 'secondary',
    song: translatedSong(),
    origin: {
      provider: 'local',
      itemId: 'steadfast-love-uk',
      revision: 'translation-revision-4'
    },
    now: '2026-07-23T18:10:00.000Z'
  });

  const linkedVariant = linked.items['song-steadfast-love'].variants.secondary;
  assert.equal(linkedVariant.mode, 'content');
  assert.equal(Object.keys(linked.resources).length, resourceCount + 1);
  assert.equal(linked.resources[linkedVariant.resourceId].origin.revision, 'translation-revision-4');
  assert.equal(original.items['song-steadfast-love'].variants.secondary.mode, 'inherit');
  const timeline = compileServiceProject(linked);
  const firstLyricsCue = timeline.cueIds
    .map(cueId => timeline.cues[cueId])
    .find(cue => cue.sourceReference?.sectionId === 'verse-1');
  assert.equal(
    firstLyricsCue.channels.secondary.blocks[0].text,
    'Щоранку знову'
  );

  const structuralMismatch = compareSongTranslations(primarySong(), translatedSong({ aligned: false }));
  assert.equal(structuralMismatch.compatible, false);
  assert.deepEqual(structuralMismatch.slideMismatches, [{
    sectionId: 'chorus',
    sourceSlides: 2,
    translationSlides: 1
  }]);
  expectProjectCode('TRANSLATION_MISMATCH', () => linkSongTranslation(original, {
    itemId: 'song-steadfast-love',
    channelId: 'secondary',
    song: translatedSong({ aligned: false }),
    now: NOW
  }));

  const unrelated = translatedSong({
    id: 'different-song-uk',
    title: 'Unrelated but shaped alike',
    translationOf: 'different-song'
  });
  assert.equal(compareSongTranslations(primarySong(), unrelated).relationshipCompatible, false);
  expectProjectCode('TRANSLATION_MISMATCH', () => linkSongTranslation(original, {
    itemId: 'song-steadfast-love',
    channelId: 'secondary',
    song: unrelated,
    now: NOW
  }));
  assert.equal(Object.keys(original.resources).length, resourceCount);
});

test('resetSongChannelVariant reverses linked output lyrics and restores Singer next-line behavior', () => {
  const original = projectWithSong();
  const secondaryLinked = linkSongTranslation(original, {
    itemId: 'song-steadfast-love',
    channelId: 'secondary',
    song: translatedSong(),
    now: NOW
  });
  const secondaryReset = resetSongChannelVariant(secondaryLinked, {
    itemId: 'song-steadfast-love',
    channelId: 'secondary',
    mode: 'inherit',
    now: NOW
  });
  assert.deepEqual(
    secondaryReset.items['song-steadfast-love'].variants.secondary,
    { mode: 'inherit', from: 'primary' }
  );
  assert.equal(
    Object.keys(secondaryReset.resources).length,
    Object.keys(original.resources).length,
    'the new semantic revision prunes the translation no remaining channel references'
  );
  assert.equal(
    secondaryReset.resources[secondaryLinked.items['song-steadfast-love'].variants.secondary.resourceId],
    undefined
  );

  const mediaLinked = linkSongTranslation(original, {
    itemId: 'song-steadfast-love',
    channelId: 'media',
    song: translatedSong(),
    now: NOW
  });
  const mediaReset = resetSongChannelVariant(mediaLinked, {
    itemId: 'song-steadfast-love',
    channelId: 'media',
    mode: 'derive',
    now: NOW
  });
  assert.deepEqual(mediaReset.items['song-steadfast-love'].variants.media, {
    mode: 'derive',
    from: 'primary',
    transform: { id: 'first-lines', version: 1, maxLines: 2 }
  });
  assert.equal(Object.keys(mediaReset.resources).length, Object.keys(original.resources).length);

  const sharedAcrossChannels = linkSongTranslation(secondaryLinked, {
    itemId: 'song-steadfast-love',
    channelId: 'media',
    song: translatedSong(),
    now: NOW
  });
  const sharedTranslationId = sharedAcrossChannels.items['song-steadfast-love'].variants.media.resourceId;
  assert.equal(
    sharedTranslationId,
    sharedAcrossChannels.items['song-steadfast-love'].variants.secondary.resourceId
  );
  const oneChannelReset = resetSongChannelVariant(sharedAcrossChannels, {
    itemId: 'song-steadfast-love',
    channelId: 'secondary',
    mode: 'inherit',
    now: NOW
  });
  assert.ok(
    oneChannelReset.resources[sharedTranslationId],
    'reset keeps a translation that the media channel still references'
  );
  const bothChannelsReset = resetSongChannelVariant(oneChannelReset, {
    itemId: 'song-steadfast-love',
    channelId: 'media',
    mode: 'derive',
    now: NOW
  });
  assert.equal(bothChannelsReset.resources[sharedTranslationId], undefined);

  expectProjectCode('PRIMARY_SONG_CHANNEL', () => resetSongChannelVariant(original, {
    itemId: 'song-steadfast-love',
    channelId: 'primary',
    mode: 'inherit',
    now: NOW
  }));
});

test('setSongChannelTreatment applies explicit sources, hidden output, pruning, no-op, and cycle checks', () => {
  const original = projectWithSong();
  const secondaryLinked = linkSongTranslation(original, {
    itemId: 'song-steadfast-love',
    channelId: 'secondary',
    song: translatedSong(),
    now: NOW
  });
  const derivedFromTranslation = setSongChannelTreatment(secondaryLinked, {
    itemId: 'song-steadfast-love',
    channelId: 'media',
    mode: 'derive-next-text',
    sourceChannelId: 'secondary',
    now: '2026-07-23T18:12:00.000Z'
  });
  assert.deepEqual(
    derivedFromTranslation.items['song-steadfast-love'].variants.media,
    {
      mode: 'derive',
      from: 'secondary',
      transform: { id: 'first-lines', version: 1, maxLines: 2 }
    }
  );

  const titledRaw = JSON.parse(serializeServiceProject(original));
  titledRaw.items['song-steadfast-love'].variants.media.titleCardMode = 'simple';
  const titled = normalizeServiceProject(titledRaw);
  const mediaLinked = linkSongTranslation(titled, {
    itemId: 'song-steadfast-love',
    channelId: 'media',
    song: translatedSong(),
    now: NOW
  });
  const displacedResourceId =
    mediaLinked.items['song-steadfast-love'].variants.media.resourceId;
  const hidden = setSongChannelTreatment(mediaLinked, {
    itemId: 'song-steadfast-love',
    channelId: 'media',
    mode: 'hidden',
    now: '2026-07-23T18:13:00.000Z'
  });
  assert.deepEqual(hidden.items['song-steadfast-love'].variants.media, {
    mode: 'hidden',
    titleCardMode: 'simple'
  });
  assert.equal(hidden.resources[displacedResourceId], undefined);

  const sourcePinned = setSongChannelTreatment(original, {
    itemId: 'song-steadfast-love',
    channelId: 'media',
    mode: 'derive-next-text',
    sourceChannelId: 'primary',
    now: '2026-07-23T18:14:00.000Z'
  });
  const unchanged = setSongChannelTreatment(sourcePinned, {
    itemId: 'song-steadfast-love',
    channelId: 'media',
    mode: 'derive-next-text',
    sourceChannelId: 'primary',
    now: '2026-07-23T18:15:00.000Z'
  });
  assert.equal(
    serializeServiceProject(unchanged),
    serializeServiceProject(sourcePinned),
    'an exact repeated treatment must remain a semantic no-op'
  );

  expectProjectCode('INVALID_SONG_TREATMENT', () =>
    setSongChannelTreatment(original, {
      itemId: 'song-steadfast-love',
      channelId: 'media',
      mode: 'automatic',
      sourceChannelId: 'primary',
      now: NOW
    }));
  expectProjectCode('MISSING_SONG_TREATMENT_SOURCE', () =>
    setSongChannelTreatment(original, {
      itemId: 'song-steadfast-love',
      channelId: 'secondary',
      mode: 'inherit',
      now: NOW
    }));
  expectProjectCode('UNKNOWN_PROJECT_CHANNEL', () =>
    setSongChannelTreatment(original, {
      itemId: 'song-steadfast-love',
      channelId: 'secondary',
      mode: 'inherit',
      sourceChannelId: 'balcony',
      now: NOW
    }));
  expectProjectCode('CHANNEL_INHERITANCE_CYCLE', () =>
    setSongChannelTreatment(original, {
      itemId: 'song-steadfast-love',
      channelId: 'secondary',
      mode: 'inherit',
      sourceChannelId: 'secondary',
      now: NOW
    }));
  expectProjectCode('PRIMARY_SONG_CHANNEL', () =>
    setSongChannelTreatment(original, {
      itemId: 'song-steadfast-love',
      channelId: 'primary',
      mode: 'hidden',
      now: NOW
    }));

  const mediaFromSecondary = setSongChannelTreatment(original, {
    itemId: 'song-steadfast-love',
    channelId: 'media',
    mode: 'inherit',
    sourceChannelId: 'secondary',
    now: NOW
  });
  expectProjectCode('CHANNEL_INHERITANCE_CYCLE', () =>
    setSongChannelTreatment(mediaFromSecondary, {
      itemId: 'song-steadfast-love',
      channelId: 'secondary',
      mode: 'inherit',
      sourceChannelId: 'media',
      now: NOW
    }));
});

test('translation replacement prunes only the displaced resource and cannot replace the authoritative source', () => {
  const original = projectWithSong();
  expectProjectCode('PRIMARY_SONG_CHANNEL', () => linkSongTranslation(original, {
    itemId: 'song-steadfast-love',
    channelId: 'primary',
    song: translatedSong(),
    now: NOW
  }));

  const first = linkSongTranslation(original, {
    itemId: 'song-steadfast-love',
    channelId: 'secondary',
    song: translatedSong(),
    now: NOW
  });
  const firstTranslationId = first.items['song-steadfast-love'].variants.secondary.resourceId;
  const second = linkSongTranslation(first, {
    itemId: 'song-steadfast-love',
    channelId: 'secondary',
    song: translatedSong({
      id: 'steadfast-love-es',
      title: 'Amor fiel'
    }),
    now: '2026-07-23T18:11:00.000Z'
  });
  const secondTranslationId = second.items['song-steadfast-love'].variants.secondary.resourceId;

  assert.notEqual(secondTranslationId, firstTranslationId);
  assert.equal(second.resources[firstTranslationId], undefined);
  assert.ok(second.resources[secondTranslationId]);
  assert.ok(second.resources[original.items['song-steadfast-love'].variants.primary.resourceId]);
  assert.equal(Object.keys(second.resources).length, 2);
  assert.ok(first.resources[firstTranslationId], 'the immutable input revision retains its pinned translation');
});

test('authoritative song source survives media-first channel order, translation links, arrangement, and reset', () => {
  let project = createServiceProject({
    id: 'media-first-service',
    title: 'Media-first service',
    serviceDate: '2026-07-26',
    profileId: 'main-sanctuary',
    now: NOW,
    channels: [
      { id: 'media', label: 'Singers', language: 'en' },
      { id: 'primary', label: 'Main', language: 'en' },
      { id: 'secondary', label: 'Second language', language: 'uk' }
    ]
  });
  const pinned = addSongResource(project, primarySong(), {
    provider: 'local',
    itemId: 'steadfast-love',
    revision: 'song-revision-1'
  });
  project = addProjectItem(pinned.project, {
    id: 'song-media-first',
    kind: 'song',
    title: 'Steadfast Love',
    variants: {
      media: {
        mode: 'derive',
        from: 'primary',
        transform: { id: 'first-lines', version: 1, maxLines: 2 }
      },
      primary: { mode: 'content', resourceId: pinned.resourceId },
      secondary: { mode: 'inherit', from: 'primary' }
    },
    arrangement: [
      { id: 'arr-media-first-verse', sectionId: 'verse-1' },
      { id: 'arr-media-first-chorus', sectionId: 'chorus' }
    ],
    titlePresetId: 'song-title',
    lyricsPresetId: 'song-lyrics',
    operatorNotes: ''
  }, { now: NOW });

  assert.equal(Object.hasOwn(project.items['song-media-first'], 'primaryChannelId'), false);
  const legacyCanonical = serializeServiceProject(project);
  assert.equal(
    serializeServiceProject(normalizeServiceProject(JSON.parse(legacyCanonical))),
    legacyCanonical,
    'deriving a legacy source must not rewrite an immutable historical revision'
  );
  assert.equal(resolveAuthoritativeSongSource(project, 'song-media-first').channelId, 'primary');
  const mediaLinked = linkSongTranslation(project, {
    itemId: 'song-media-first',
    channelId: 'media',
    song: translatedSong(),
    now: NOW
  });
  assert.equal(mediaLinked.items['song-media-first'].primaryChannelId, 'primary');
  assert.equal(resolveAuthoritativeSongSource(mediaLinked, 'song-media-first').channelId, 'primary');

  const arranged = updateSongArrangement(mediaLinked, {
    itemId: 'song-media-first',
    arrangement: [
      { id: 'arr-media-first-chorus', sectionId: 'chorus' },
      { id: 'arr-media-first-verse', sectionId: 'verse-1' }
    ],
    now: NOW
  });
  const mediaReset = resetSongChannelVariant(arranged, {
    itemId: 'song-media-first',
    channelId: 'media',
    mode: 'derive',
    now: NOW
  });
  assert.equal(resolveAuthoritativeSongSource(mediaReset, 'song-media-first').channelId, 'primary');
  assert.deepEqual(mediaReset.items['song-media-first'].variants.media, {
    mode: 'derive',
    from: 'primary',
    transform: { id: 'first-lines', version: 1, maxLines: 2 }
  });

  const secondaryLinked = linkSongTranslation(mediaReset, {
    itemId: 'song-media-first',
    channelId: 'secondary',
    song: translatedSong(),
    now: NOW
  });
  assert.equal(resolveAuthoritativeSongSource(secondaryLinked, 'song-media-first').channelId, 'primary');
  expectProjectCode('PRIMARY_SONG_CHANNEL', () => linkSongTranslation(secondaryLinked, {
    itemId: 'song-media-first',
    channelId: 'primary',
    song: translatedSong(),
    now: NOW
  }));
});

test('addBibleItem stores a checked offline snapshot inline and refuses range drift or text tampering', () => {
  const project = addBibleItem(freshProject(), {
    id: 'bible-john-3-16',
    passagesByChannel: {
      primary: biblePassage(),
      secondary: biblePassage({
        translationId: 'LSV',
        attribution: 'LSV required attribution'
      })
    },
    now: NOW
  });
  const item = project.items['bible-john-3-16'];

  assert.deepEqual(item.range, {
    bookId: 'john',
    start: { chapter: 3, verse: 16 },
    end: { chapter: 3, verse: 17 }
  });
  assert.equal(item.title, 'John 3:16–17');
  assert.match(item.passagesByChannel.primary.contentSha256, /^[a-f0-9]{64}$/);
  assert.equal(item.passagesByChannel.primary.attribution, 'BSB pinned source credit');
  assert.equal(item.passagesByChannel.secondary.attribution, 'LSV required attribution');
  assert.deepEqual(project.resources, {}, 'Bible text is an inline immutable snapshot, not a live library pointer');
  const timeline = compileServiceProject(project);
  const compiledBlock = timeline.cues[timeline.cueIds[0]].channels.primary.blocks[0];
  assert.equal(compiledBlock.contentSha256, item.passagesByChannel.primary.contentSha256);

  const tampered = JSON.parse(serializeServiceProject(project));
  tampered.items['bible-john-3-16'].passagesByChannel.primary.verses[0].text = 'Changed after pinning';
  expectProjectCode('BIBLE_CONTENT_HASH_MISMATCH', () => normalizeServiceProject(tampered));

  expectProjectCode('BIBLE_RANGE_MISMATCH', () => addBibleItem(freshProject(), {
    id: 'mismatched-bible',
    passagesByChannel: {
      primary: biblePassage(),
      secondary: biblePassage({ translationId: 'LSV', verseStart: 17, verseEnd: 18 })
    },
    now: NOW
  }));
  expectProjectCode('UNKNOWN_PROJECT_CHANNEL', () => addBibleItem(freshProject(), {
    id: 'unknown-channel-bible',
    passagesByChannel: { balcony: biblePassage() },
    now: NOW
  }));
});
