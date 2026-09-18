'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');

const {
  lookupCanonicalRange
} = require('../../src/services/bible');
const {
  LocalSongLibrary,
  ServiceProjectStore,
  addBibleItem,
  addGroupItem,
  addProjectItem,
  addSermonResource,
  addSongResource,
  analyzeSermonPrimaryReading,
  applyCanonicalSermonBodyProjection,
  buildCanonicalSermonBodyProjectionProposal,
  parseSongDocument,
  placeBibleReadingItemsBefore,
  replaceSongItem,
  serviceProjectRevisionId,
  setSermonSourceLink,
  setServicePlanStatus
} = require('../../src/services/project');

const PRIOR_NOW = '2026-08-02T16:00:00.000Z';
const PLAN_NOW = '2026-08-09T15:30:00.000Z';
const READY_NOW = '2026-08-09T16:45:00.000Z';
const PRIOR_PROJECT_ID = 'native-weekly-2026-08-02';
const READY_PROJECT_ID = 'native-weekly-2026-08-09';
const PROFILE_ID = 'main-sanctuary';
const CHANNELS = Object.freeze([
  Object.freeze({ id: 'primary', label: 'Russian', language: 'ru' }),
  Object.freeze({ id: 'secondary', label: 'English', language: 'en' }),
  Object.freeze({ id: 'media', label: 'Singers', language: 'ru' })
]);
const SERMON_READING_OUTPUTS = Object.freeze([
  Object.freeze({
    channelId: 'primary',
    mode: 'translation',
    translationId: 'BSB'
  }),
  Object.freeze({
    channelId: 'secondary',
    mode: 'translation',
    translationId: 'LSV'
  }),
  Object.freeze({
    channelId: 'media',
    mode: 'hidden'
  })
]);
const CONDENSED_SERMON_TEXT = 'The church displays God’s wisdom.';

function songSource({
  id,
  title,
  language,
  translationOf = null,
  firstLine,
  secondLine,
  chorus
}) {
  return [
    '---',
    `id: ${id}`,
    `title: ${title}`,
    `language: ${language}`,
    ...(translationOf ? [`translationOf: ${translationOf}`] : []),
    'authors: Native Weekly Fixture',
    'license: Test-only original fixture text',
    'source: SyncShow tracked native acceptance fixture',
    '---',
    '^1',
    firstLine,
    secondLine,
    '^chorus',
    chorus
  ].join('\n');
}

function priorSongSource() {
  return songSource({
    id: 'prior-week-song',
    title: 'Prior Week Song',
    language: 'ru',
    firstLine: 'Предыдущая песня',
    secondLine: 'Остается только в истории',
    chorus: 'Предыдущее припевное содержание'
  });
}

function replacementSongSources() {
  const originalId = 'native-weekly-song-ru';
  return {
    original: songSource({
      id: originalId,
      title: 'Церковь возносит хвалу',
      language: 'ru',
      firstLine: 'Церковь возносит хвалу Христу',
      secondLine: 'Его благодать хранит нас',
      chorus: 'Слава Христу во веки'
    }),
    translation: songSource({
      id: 'native-weekly-song-en',
      title: 'The Church Sings Praise',
      language: 'en',
      translationOf: originalId,
      firstLine: 'The church sings praise to Christ',
      secondLine: 'His grace preserves his people',
      chorus: 'Glory to Christ forever'
    })
  };
}

function sermonDocument({
  id,
  serviceDate,
  title,
  includeBody = false
}) {
  return {
    schemaVersion: 3,
    kind: 'syncshow-sermon',
    id,
    titles: {
      ru: title.ru,
      en: title.en
    },
    defaultLanguage: 'en',
    speaker: { id: null, name: 'Pastor Example' },
    serviceDate,
    series: null,
    outline: [],
    sources: [],
    references: [{
      id: 'primary-ephesians',
      range: {
        schemaVersion: 1,
        bookId: 'Eph',
        start: { chapter: 3, verse: 10 },
        end: { chapter: 3, verse: 12 }
      },
      role: 'primary',
      source: 'operator',
      reviewStatus: 'confirmed',
      enteredText: 'Ephesians 3:10-12',
      sourceId: null,
      sectionId: null,
      startOffset: null,
      endOffset: null
    }],
    media: [],
    publication: {
      status: 'draft',
      visibility: 'private',
      publishedAt: null,
      canonicalUrl: null
    },
    body: includeBody
      ? [{
          id: 'body-ru',
          kind: 'manuscript',
          language: 'ru',
          sourceId: null,
          sectionId: null,
          text: [
            'Церковь показывает Божью мудрость.',
            '',
            'Во Христе мы с дерзновением приходим к Богу.'
          ].join('\n')
        }, {
          id: 'body-en',
          kind: 'manuscript',
          language: 'en',
          sourceId: null,
          sectionId: null,
          text: [
            'The church displays the wisdom of God.',
            '',
            'In Christ we approach God with confidence.'
          ].join('\n')
        }]
      : []
  };
}

function passageFor(channelId) {
  const russian = channelId !== 'secondary';
  const verses = russian
    ? [
        'Чтобы ныне соделалась известною через Церковь многоразличная премудрость Божия.',
        'По предвечному определению, которое Он исполнил во Христе Иисусе.',
        'В Котором мы имеем дерзновение и надежный доступ через веру в Него.'
      ]
    : [
        'His purpose was that now, through the church, the manifold wisdom of God should be made known.',
        'This was according to the eternal purpose that He accomplished in Christ Jesus our Lord.',
        'In Him and through faith in Him we may enter God’s presence with boldness and confidence.'
      ];
  return {
    reference: russian ? 'К Ефесянам 3:10–12' : 'Ephesians 3:10–12',
    translationId: 'FIXTURE',
    attribution: 'Tracked test-only Scripture paraphrase',
    verses: verses.map((text, index) => ({
      number: index + 10,
      text
    }))
  };
}

function addPriorSermonOccurrence(project) {
  const pinned = addSermonResource(project, sermonDocument({
    id: 'prior-week-sermon',
    serviceDate: '2026-08-02',
    title: {
      ru: 'Предыдущая проповедь',
      en: 'Prior Week Sermon'
    }
  }));
  let next = setSermonSourceLink(pinned.project, {
    itemId: 'sermon',
    sermonResourceId: pinned.resourceId,
    sermonSectionId: null,
    now: PRIOR_NOW
  });
  next = addBibleItem(next, {
    id: 'prior-sermon-reading',
    title: 'Prior sermon reading',
    range: {
      schemaVersion: 1,
      bookId: 'Eph',
      start: { chapter: 3, verse: 10 },
      end: { chapter: 3, verse: 12 }
    },
    passagesByChannel: Object.fromEntries(
      CHANNELS.map(channel => [channel.id, passageFor(channel.id)])
    ),
    sermonReading: {
      sermonResourceId: pinned.resourceId,
      referenceId: 'primary-ephesians',
      translationId: 'FIXTURE',
      chunkIndex: 0,
      chunkCount: 1
    },
    parentId: 'service',
    now: PRIOR_NOW
  });
  next = addProjectItem(next, {
    id: 'prior-sermon-cue',
    kind: 'sermon',
    title: 'Prior sermon cue',
    textByChannel: {
      primary: 'Предыдущее содержание проповеди',
      secondary: 'Prior sermon material',
      media: 'Предыдущее содержание'
    },
    presetId: 'sermon-notes',
    operatorNotes: 'This occurrence must not carry into the next service.'
  }, {
    parentId: 'sermon',
    now: PRIOR_NOW
  });
  return placeBibleReadingItemsBefore(next, {
    itemIds: ['prior-sermon-reading'],
    anchorItemId: 'sermon'
  });
}

function preparePriorProject(draft, priorSong) {
  let project = addGroupItem(draft, {
    id: 'service',
    title: 'Service',
    groupKind: 'service',
    now: PRIOR_NOW
  });
  project = addGroupItem(project, {
    id: 'opening',
    title: 'Communal singing',
    groupKind: 'section',
    parentId: 'service',
    now: PRIOR_NOW
  });
  const pinnedSong = addSongResource(project, priorSong, {
    provider: 'local',
    itemId: priorSong.id,
    revision: 'prior-week-library-revision'
  });
  project = addProjectItem(pinnedSong.project, {
    id: 'prior-week-song-item',
    kind: 'song',
    title: priorSong.title,
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
    arrangement: [
      { id: 'prior-arrangement-verse', sectionId: 'verse-1' },
      { id: 'prior-arrangement-chorus', sectionId: 'chorus' }
    ],
    titlePresetId: 'song-title',
    lyricsPresetId: 'song-lyrics',
    operatorNotes: ''
  }, {
    parentId: 'opening',
    now: PRIOR_NOW
  });
  project = addProjectItem(project, {
    id: 'welcome-notice',
    kind: 'notice',
    title: 'Welcome',
    textByChannel: {
      primary: 'Добро пожаловать',
      secondary: 'Welcome',
      media: 'Добро пожаловать'
    },
    presetId: 'notice-text',
    operatorNotes: 'Advance after the welcome.'
  }, {
    parentId: 'opening',
    now: PRIOR_NOW
  });
  project = addGroupItem(project, {
    id: 'sermon',
    title: 'Sermon',
    groupKind: 'sermon',
    parentId: 'service',
    now: PRIOR_NOW
  });
  project = addProjectItem(project, {
    id: 'closing-blank',
    kind: 'blank',
    title: 'Intentional closing black',
    channelIds: CHANNELS.map(channel => channel.id),
    presetId: 'blank-black',
    operatorNotes: ''
  }, {
    parentId: 'service',
    now: PRIOR_NOW
  });
  return addPriorSermonOccurrence(project);
}

async function createPriorService({
  projectStore,
  songLibrary,
  workspace
}) {
  const priorLibrarySong = await songLibrary.saveSource(priorSongSource(), {
    fileName: 'prior-week-song.md',
    expectedRevision: null
  });
  const created = await projectStore.create({
    id: PRIOR_PROJECT_ID,
    title: 'Native Weekly Service — August 2',
    serviceDate: '2026-08-02',
    profileId: PROFILE_ID,
    channels: CHANNELS
  }, {
    prepareProject: draft =>
      preparePriorProject(draft, priorLibrarySong.song)
  });

  const picturePath = path.join(workspace, 'tracked-native-welcome.png');
  await sharp({
    create: {
      width: 160,
      height: 90,
      channels: 3,
      background: '#173a63'
    }
  }).png().toFile(picturePath);
  const withPicture = await projectStore.importImageAndUpdateProject(
    created.project.id,
    {
      sourcePath: picturePath,
      expectedRevisionId: created.revisionId,
      altText: 'Blue welcome background',
      attribution: 'SyncShow tracked native fixture',
      reason: 'native-weekly-picture'
    },
    (project, asset) => addProjectItem(project, {
      id: 'welcome-picture',
      kind: 'picture',
      title: 'Welcome artwork',
      assetId: asset.id,
      channelIds: CHANNELS.map(channel => channel.id),
      fit: 'fit',
      focalPoint: { x: 0.5, y: 0.5 },
      altText: asset.altText,
      attribution: asset.attribution,
      presetId: 'picture-fullscreen',
      operatorNotes: ''
    }, {
      parentId: 'opening',
      now: PRIOR_NOW
    })
  );
  await fs.unlink(picturePath);
  return withPicture;
}

async function replacePlannedSong(project, songLibrary) {
  const sources = replacementSongSources();
  const original = await songLibrary.saveSource(sources.original, {
    fileName: 'native-weekly-song-ru.md',
    expectedRevision: null
  });
  const translation = await songLibrary.saveSource(sources.translation, {
    fileName: 'native-weekly-song-en.md',
    expectedRevision: null
  });
  const pinnedOriginal = addSongResource(project, original.song, {
    provider: 'local',
    itemId: original.song.id,
    revision: original.revision
  });
  const pinnedTranslation = addSongResource(
    pinnedOriginal.project,
    translation.song,
    {
      provider: 'local',
      itemId: translation.song.id,
      revision: translation.revision
    }
  );
  const replaced = replaceSongItem(
    pinnedTranslation.project,
    'prior-week-song-item',
    {
      id: 'native-weekly-song-item',
      kind: 'song',
      title: original.song.title,
      primaryChannelId: 'primary',
      variants: {
        primary: {
          mode: 'content',
          resourceId: pinnedOriginal.resourceId
        },
        secondary: {
          mode: 'content',
          resourceId: pinnedTranslation.resourceId
        },
        media: {
          mode: 'derive',
          from: 'primary',
          transform: { id: 'first-lines', version: 1, maxLines: 2 }
        }
      },
      arrangement: [
        { id: 'weekly-arrangement-verse', sectionId: 'verse-1' },
        { id: 'weekly-arrangement-chorus', sectionId: 'chorus' }
      ],
      titlePresetId: 'song-title',
      lyricsPresetId: 'song-lyrics',
      operatorNotes: ''
    },
    { now: READY_NOW }
  );
  return {
    project: replaced,
    original,
    translation,
    originalResourceId: pinnedOriginal.resourceId,
    translationResourceId: pinnedTranslation.resourceId
  };
}

async function resolvedReadingPassages(chunk) {
  const canonicalRange = {
    book: chunk.range.bookId,
    startChapter: chunk.range.start.chapter,
    startVerse: chunk.range.start.verse,
    endChapter: chunk.range.end.chapter,
    endVerse: chunk.range.end.verse
  };
  const passagesByChannel = {};
  for (const output of SERMON_READING_OUTPUTS) {
    if (output.mode === 'hidden') continue;
    const result = await lookupCanonicalRange(canonicalRange, {
      translationId: output.translationId
    });
    if (result.status !== 'ok') {
      throw new Error(
        `Tracked ${output.translationId} sermon reading is unavailable: `
        + `${result.code || result.message || 'unknown Bible lookup error'}`
      );
    }
    const passage = result.passage;
    passagesByChannel[output.channelId] = {
      translation: passage.translation,
      reference: passage.reference,
      verses: passage.verses
    };
  }
  return passagesByChannel;
}

async function addReviewedSermon(project) {
  const sermon = sermonDocument({
    id: 'native-weekly-sermon',
    serviceDate: '2026-08-09',
    title: {
      ru: 'Церковь показывает Божью мудрость',
      en: 'The Church Displays God’s Wisdom'
    },
    includeBody: true
  });
  const pinned = addSermonResource(project, sermon, {
    provider: 'local-sermon-library',
    itemId: sermon.id,
    revision: 'tracked-native-sermon-revision'
  });
  let next = setSermonSourceLink(pinned.project, {
    itemId: 'sermon',
    sermonResourceId: pinned.resourceId,
    sermonSectionId: null,
    now: READY_NOW
  });

  const readingPlan = analyzeSermonPrimaryReading(next, {
    itemId: 'sermon',
    referenceId: 'primary-ephesians',
    outputs: SERMON_READING_OUTPUTS,
    maxVerses: 8
  });
  for (const chunk of readingPlan.chunks) {
    next = addBibleItem(next, {
      id: `native-sermon-reading-${chunk.chunkIndex + 1}`,
      title: `${chunk.reference} (tracked fixture)`,
      range: chunk.range,
      passagesByChannel: await resolvedReadingPassages(chunk),
      sermonReading: {
        sermonResourceId: pinned.resourceId,
        referenceId: readingPlan.referenceId,
        outputs: SERMON_READING_OUTPUTS,
        chunkIndex: chunk.chunkIndex,
        chunkCount: readingPlan.chunks.length
      },
      parentId: 'service',
      now: READY_NOW
    });
  }
  next = placeBibleReadingItemsBefore(next, {
    itemIds: readingPlan.chunks.map(chunk =>
      `native-sermon-reading-${chunk.chunkIndex + 1}`),
    anchorItemId: readingPlan.anchorItemId
  });

  const proposal = buildCanonicalSermonBodyProjectionProposal({
    project: next,
    projectRevisionId: serviceProjectRevisionId(next),
    anchorItemId: 'sermon',
    sermonId: sermon.id,
    sermonRevisionId: pinned.resourceId.slice('sha256:'.length),
    channelMappings: [{
      channelId: 'primary',
      mode: 'body-entry',
      bodyEntryId: 'body-ru'
    }, {
      channelId: 'secondary',
      mode: 'body-entry',
      bodyEntryId: 'body-en'
    }, {
      channelId: 'media',
      mode: 'hidden'
    }],
    now: READY_NOW
  });
  const applied = applyCanonicalSermonBodyProjection({
    project: next,
    proposal,
    decisions: {
      rows: [{
        rowId: 'weekly-sermon-row-1',
        action: 'insert',
        treatmentsByChannel: {
          primary: {
            mode: 'exact',
            paragraphId: 'paragraph-001'
          },
          secondary: {
            mode: 'condensed',
            paragraphId: 'paragraph-001',
            text: CONDENSED_SERMON_TEXT
          },
          media: {
            mode: 'hidden'
          }
        }
      }, {
        rowId: 'weekly-sermon-row-2',
        action: 'insert',
        paragraphIdsByChannel: {
          primary: 'paragraph-002',
          secondary: 'paragraph-002',
          media: null
        }
      }],
      skippedParagraphIdsByChannel: {
        primary: [],
        secondary: [],
        media: []
      }
    },
    confirmed: true,
    idFactory: ({ ordinal }) => `native-sermon-slide-${ordinal}`
  });
  return {
    project: applied.project,
    sermon,
    sermonResourceId: pinned.resourceId,
    readingPlan,
    proposal,
    insertedSermonItemIds: applied.insertedItemIds
  };
}

async function createTrackedNativeWeeklyService(workspace) {
  if (typeof workspace !== 'string' || !path.isAbsolute(workspace)) {
    throw new TypeError('Tracked native weekly fixture requires an absolute workspace.');
  }
  await fs.mkdir(workspace, { recursive: true });
  let currentTime = PRIOR_NOW;
  const clock = () => new Date(currentTime);
  const projectStore = new ServiceProjectStore({
    rootPath: path.join(workspace, 'service-projects'),
    clock
  });
  const songLibrary = new LocalSongLibrary({
    rootPath: path.join(workspace, 'song-library'),
    clock
  });
  const prior = await createPriorService({
    projectStore,
    songLibrary,
    workspace
  });

  currentTime = PLAN_NOW;
  const planned = await projectStore.planNextService(prior.project.id, {
    sourceRevisionId: prior.revisionId,
    id: READY_PROJECT_ID,
    title: 'Native Weekly Service — August 9',
    serviceDate: '2026-08-09',
    startTime: '10:30',
    teamNotes: 'Volunteer advances with Right Arrow or Space.'
  });

  currentTime = READY_NOW;
  const replacement = await replacePlannedSong(
    planned.project,
    songLibrary
  );
  const reviewedSermon = await addReviewedSermon(replacement.project);
  const readyProject = setServicePlanStatus(
    reviewedSermon.project,
    'ready'
  );
  const ready = await projectStore.save(readyProject, {
    expectedRevisionId: planned.revisionId,
    reason: 'native-weekly-ready'
  });

  return Object.freeze({
    workspace,
    projectStore,
    songLibrary,
    prior,
    planned,
    ready,
    replacement: Object.freeze(replacement),
    reviewedSermon: Object.freeze(reviewedSermon)
  });
}

module.exports = {
  CHANNELS,
  CONDENSED_SERMON_TEXT,
  PLAN_NOW,
  PRIOR_NOW,
  PRIOR_PROJECT_ID,
  PROFILE_ID,
  READY_NOW,
  READY_PROJECT_ID,
  SERMON_READING_OUTPUTS,
  createTrackedNativeWeeklyService,
  replacementSongSources,
  sermonDocument
};
