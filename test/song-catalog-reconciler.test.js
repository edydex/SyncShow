'use strict';

const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const test = require('node:test');

const {
  LocalSongLibrary,
  OUTPUT_ONLY_SONG_PROVIDER,
  addProjectItem,
  addSongResource,
  compileServiceProject,
  compareSongTranslations,
  createServiceProject,
  importPortableProjectSongs,
  normalizeSongDocument,
  parseSongDocument,
  reachableSongResources,
  resolveAuthoritativeSongSource,
  serializeServiceProject,
  serializeSongDocument
} = require('../src/services/project');
const {
  canonicalSongId,
  reconcileServiceSongCatalog,
  songContentFingerprint
} = require('../scripts/lib/song-catalog-reconciler');

function song(options = {}) {
  const sections = options.sections || [
    {
      id: 'verse-1',
      marker: '1',
      label: 'Verse 1',
      slides: [{ lines: options.verseLines || ['Grace has found me', 'Mercy leads me home'] }]
    },
    {
      id: 'chorus',
      marker: 'chorus',
      label: 'Chorus',
      slides: [{ lines: options.chorusLines || ['Sing glory', 'Sing amen'] }]
    }
  ];
  return normalizeSongDocument({
    schemaVersion: 1,
    id: options.id || 'source-song',
    title: options.title || 'Grace Song',
    language: options.language || 'ru',
    translationOf: options.translationOf || null,
    license: options.license || '',
    tags: options.tags || [],
    authors: options.authors || [],
    translators: options.translators || [],
    composers: options.composers || [],
    source: options.source || '',
    attribution: options.attribution || '',
    extraMetadata: options.extraMetadata || {},
    sections
  });
}

function serviceProject(options = {}) {
  let project = createServiceProject({
    id: options.id,
    title: options.title || options.id,
    serviceDate: options.serviceDate,
    preferredProfileId: 'default',
    channels: [
      { id: 'primary', label: 'Primary', language: 'ru' },
      { id: 'secondary', label: 'Secondary', language: 'en' },
      { id: 'media', label: 'Singers', language: 'ru' }
    ],
    now: `${options.serviceDate}T12:00:00.000Z`
  });
  const resources = {};
  for (const entry of options.documents) {
    const pinned = addSongResource(project, entry.document, {
      provider: entry.outputOnly ? OUTPUT_ONLY_SONG_PROVIDER : 'pptx-service-import',
      providerId: options.id,
      itemId: entry.document.id
    });
    project = pinned.project;
    resources[entry.channelId] = pinned.resourceId;
  }
  const variants = {};
  for (const channelId of project.channelIds) {
    if (resources[channelId]) {
      variants[channelId] = { mode: 'content', resourceId: resources[channelId] };
    } else {
      variants[channelId] = channelId === 'media'
        ? {
            mode: 'derive',
            from: 'primary',
            transform: { id: 'first-lines', version: 1, maxLines: 2 }
          }
        : { mode: 'hidden' };
    }
  }
  project = addProjectItem(project, {
    id: `${options.id}-song`,
    kind: 'song',
    title: options.title || 'Grace Song',
    primaryChannelId: 'primary',
    variants,
    arrangement: options.arrangement.map((sectionId, index) => ({
      id: `${options.id}-arr-${index + 1}`,
      sectionId
    })),
    titlePresetId: 'song-title',
    lyricsPresetId: 'song-lyrics'
  }, { now: `${options.serviceDate}T12:00:00.000Z` });
  return project;
}

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'syncshow-song-catalog-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return fs.realpath(directory);
}

test('content identity ignores service date, title, ids, credits, and arrangement', () => {
  const first = song({
    id: 'dated-2026-07-19',
    title: 'Grace Song',
    authors: ['First credit']
  });
  const second = song({
    id: 'dated-2026-07-26',
    title: 'Благодать',
    authors: ['Expanded credit', 'First credit']
  });
  assert.equal(songContentFingerprint(first), songContentFingerprint(second));
  assert.equal(canonicalSongId(first), canonicalSongId(second));

  const changed = song({
    id: 'dated-2026-07-26',
    title: 'Grace Song',
    verseLines: ['Grace has changed', 'Mercy leads me home']
  });
  assert.notEqual(songContentFingerprint(first), songContentFingerprint(changed));
});

test('reconciliation preserves song ids while canonicalizing section ids and arrangements for portable import', async t => {
  const sections = [
    {
      id: 'part-01',
      marker: 'P1',
      label: 'Part 1 (provisional)',
      slides: [{ lines: ['Root part one'] }]
    },
    {
      id: 'part-02',
      marker: 'P2',
      label: 'Part 2 (provisional)',
      slides: [{ lines: ['Root part two'] }]
    }
  ];
  const original = song({
    id: 'programmatic-original',
    title: 'Programmatic Original',
    sections
  });
  const translation = song({
    id: 'programmatic-translation',
    title: 'Programmatic Translation',
    language: 'en',
    translationOf: original.id,
    sections: sections.map((section, index) => ({
      ...section,
      slides: [{ lines: [`Translation part ${index + 1}`] }]
    }))
  });
  const legacyOriginalId = canonicalSongId(original);
  const project = serviceProject({
    id: 'programmatic-service',
    serviceDate: '2026-08-30',
    arrangement: ['part-01', 'part-02', 'part-01'],
    documents: [
      { channelId: 'primary', document: original },
      { channelId: 'secondary', document: translation }
    ]
  });

  const reconciled = reconcileServiceSongCatalog([{ id: project.id, project }]);
  const service = reconciled.services[0];
  const item = service.project.items['programmatic-service-song'];
  const primary = resolveAuthoritativeSongSource(service.project, item.id).resource.document;
  const translatedResource = service.project.resources[item.variants.secondary.resourceId].document;

  assert.equal(primary.id, legacyOriginalId);
  assert.deepEqual(primary.sections.map(section => section.id), ['p1', 'p2']);
  assert.deepEqual(
    item.arrangement.map(entry => entry.sectionId),
    ['p1', 'p2', 'p1']
  );
  assert.deepEqual(
    parseSongDocument(serializeSongDocument(primary)).sections.map(section => section.id),
    ['p1', 'p2']
  );
  assert.equal(compareSongTranslations(primary, translatedResource).compatible, true);

  const root = await temporaryDirectory(t);
  const library = new LocalSongLibrary({ rootPath: path.join(root, 'song-library') });
  const hydration = await importPortableProjectSongs(service.project, library);
  assert.equal(hydration.added, 2);
  const listed = await library.list({ query: primary.id, pageSize: 100, offset: 0 });
  const candidates = [];
  for (const summary of listed.items) {
    if (summary.id === primary.id) continue;
    const candidate = await library.read(summary.id, { revision: summary.revision });
    if (compareSongTranslations(primary, candidate.song).compatible) {
      candidates.push(candidate.song.id);
    }
  }
  assert.deepEqual(candidates, [translatedResource.id]);
});

test('multi-service reconciliation deduplicates exact language documents and preserves arrangements', async t => {
  const russianOne = song({
    id: 'july-19-grace-ru',
    title: 'Благодать',
    authors: ['O. Author'],
    tags: ['worship']
  });
  const englishOne = song({
    id: 'july-19-grace-en',
    title: 'Grace',
    language: 'en',
    translationOf: russianOne.id,
    translators: ['T. Translator'],
    verseLines: ['Grace has found me', 'Mercy leads me home'],
    chorusLines: ['Sing glory', 'Sing amen']
  });
  const mediaOne = song({
    id: 'july-19-grace-media',
    title: 'Grace — next line operator output',
    translationOf: russianOne.id,
    verseLines: ['Next: Mercy leads me home'],
    chorusLines: ['Next: Sing amen']
  });
  const russianTwo = song({
    id: 'july-26-grace-russian',
    title: 'Песня Благодати',
    authors: ['O. Author', 'Additional verified author'],
    tags: ['congregational']
  });
  const englishTwo = song({
    id: 'july-26-grace-english',
    title: 'Song of Grace',
    language: 'en',
    translationOf: russianTwo.id,
    translators: ['T. Translator'],
    verseLines: ['Grace has found me', 'Mercy leads me home'],
    chorusLines: ['Sing glory', 'Sing amen']
  });
  const firstProject = serviceProject({
    id: 'service-2026-07-19',
    serviceDate: '2026-07-19',
    arrangement: ['verse-1', 'chorus', 'chorus'],
    documents: [
      { channelId: 'primary', document: russianOne },
      { channelId: 'secondary', document: englishOne },
      { channelId: 'media', document: mediaOne, outputOnly: true }
    ]
  });
  const secondProject = serviceProject({
    id: 'service-2026-07-26',
    serviceDate: '2026-07-26',
    arrangement: ['chorus', 'verse-1'],
    documents: [
      { channelId: 'primary', document: russianTwo },
      { channelId: 'secondary', document: englishTwo }
    ]
  });

  const reconciled = reconcileServiceSongCatalog([
    { id: 'service-2026-07-26', project: secondProject },
    { id: 'service-2026-07-19', project: firstProject }
  ]);
  assert.deepEqual(reconciled.summary, {
    serviceCount: 2,
    referencedResourceCount: 5,
    catalogSongCount: 2,
    exactReuseCount: 2,
    outputOnlyResourceCount: 1,
    reviewItemCount: 0,
    omittedReviewItems: 0
  });
  assert.equal(reconciled.catalog.songs.length, 2);
  assert.equal(
    reconciled.catalog.songs.some(entry => entry.aliases.ids.includes(mediaOne.id)),
    false
  );
  const russian = reconciled.catalog.songs.find(entry => entry.document.language === 'ru');
  const english = reconciled.catalog.songs.find(entry => entry.document.language === 'en');
  assert.ok(russian);
  assert.ok(english);
  assert.equal(english.document.translationOf, russian.id);
  assert.deepEqual(russian.document.authors, ['Additional verified author', 'O. Author']);
  assert.deepEqual(russian.document.tags, ['congregational', 'worship']);

  const july19 = reconciled.services.find(service => service.id === 'service-2026-07-19');
  const july26 = reconciled.services.find(service => service.id === 'service-2026-07-26');
  assert.deepEqual(
    july19.project.items['service-2026-07-19-song'].arrangement.map(entry => entry.sectionId),
    ['verse-1', 'chorus', 'chorus']
  );
  assert.deepEqual(
    july26.project.items['service-2026-07-26-song'].arrangement.map(entry => entry.sectionId),
    ['chorus', 'verse-1']
  );
  const july19MediaId = july19.project.items['service-2026-07-19-song'].variants.media.resourceId;
  assert.equal(july19.project.resources[july19MediaId].document.id, mediaOne.id);
  assert.equal(july19.project.resources[july19MediaId].document.translationOf, russian.id);
  assert.equal(july19.project.resources[july19MediaId].origin.provider, OUTPUT_ONLY_SONG_PROVIDER);
  assert.equal(
    compileServiceProject(july19.project).cueIds.length > 0,
    true
  );
  assert.deepEqual(
    reachableSongResources(july19.project).map(resource => resource.document.id).sort(),
    [english.id, russian.id].sort()
  );

  const root = await temporaryDirectory(t);
  const library = new LocalSongLibrary({ rootPath: path.join(root, 'song-library') });
  const hydration = await importPortableProjectSongs(july19.project, library);
  assert.deepEqual(
    {
      discovered: hydration.discovered,
      added: hydration.added,
      conflicts: hydration.conflicts,
      failed: hydration.failed
    },
    { discovered: 2, added: 2, conflicts: 0, failed: 0 }
  );
  assert.equal((await library.list()).total, 2);
  await assert.rejects(
    library.read(mediaOne.id),
    error => error?.code === 'SONG_NOT_FOUND'
  );

  const reversed = reconcileServiceSongCatalog([
    { id: 'service-2026-07-19', project: firstProject },
    { id: 'service-2026-07-26', project: secondProject }
  ]);
  assert.deepEqual(reversed.catalog, reconciled.catalog);
  assert.deepEqual(
    reversed.services.map(service => [service.id, serializeServiceProject(service.project)]),
    reconciled.services.map(service => [service.id, serializeServiceProject(service.project)])
  );
});

test('text and credit disagreements remain separate or reviewable instead of fuzzy overwrites', () => {
  const creditLeft = song({
    id: 'credit-left',
    title: 'Shared Song',
    authors: ['Alpha Author']
  });
  const creditRight = song({
    id: 'credit-right',
    title: 'Shared Song',
    authors: ['Beta Author']
  });
  const changedText = song({
    id: 'credit-left',
    title: 'Shared Song',
    verseLines: ['A genuinely different lyric', 'Mercy leads me home']
  });
  const services = [
    {
      id: 'credit-a',
      project: serviceProject({
        id: 'credit-a',
        serviceDate: '2026-08-02',
        arrangement: ['verse-1', 'chorus'],
        documents: [{ channelId: 'primary', document: creditLeft }]
      })
    },
    {
      id: 'credit-b',
      project: serviceProject({
        id: 'credit-b',
        serviceDate: '2026-08-09',
        arrangement: ['verse-1', 'chorus'],
        documents: [{ channelId: 'primary', document: creditRight }]
      })
    },
    {
      id: 'text-change',
      project: serviceProject({
        id: 'text-change',
        serviceDate: '2026-08-16',
        arrangement: ['verse-1', 'chorus'],
        documents: [{ channelId: 'primary', document: changedText }]
      })
    }
  ];

  const reconciled = reconcileServiceSongCatalog(services);
  assert.equal(reconciled.catalog.songs.length, 2);
  assert.equal(
    reconciled.reviewItems.some(item =>
      item.code === 'SONG_CREDIT_CONFLICT' && item.field === 'authors'),
    true
  );
  assert.equal(
    reconciled.reviewItems.some(item =>
      item.code === 'SONG_TEXT_CONFLICT' && item.songId === 'credit-left'),
    true
  );
  assert.equal(
    reconciled.reviewItems.some(item => item.code === 'SONG_TITLE_TEXT_VARIANTS'),
    true
  );
  const shared = reconciled.catalog.songs.find(entry =>
    entry.aliases.ids.includes('credit-right'));
  assert.deepEqual(shared.document.authors, ['Alpha Author']);
  const textVariant = reconciled.catalog.songs.find(entry =>
    entry.aliases.ids.length === 1 && entry.aliases.ids[0] === 'credit-left');
  assert.notEqual(shared.id, textVariant.id);
});

test('portable handoff carries an unused pinned translation root before its used translation', async t => {
  const original = song({
    id: 'pinned-original',
    title: 'Pinned Original',
    language: 'ru'
  });
  const translation = song({
    id: 'used-translation',
    title: 'Used Translation',
    language: 'en',
    translationOf: original.id,
    verseLines: ['Grace has found me', 'Mercy leads me home'],
    chorusLines: ['Sing glory', 'Sing amen']
  });
  let project = createServiceProject({
    id: 'translation-only-service',
    title: 'Translation-only service',
    serviceDate: '2026-08-23',
    preferredProfileId: 'default',
    channels: [{ id: 'primary', label: 'Primary', language: 'en' }],
    now: '2026-08-23T12:00:00.000Z'
  });
  const originalPin = addSongResource(project, original, {
    provider: 'pptx-service-import',
    itemId: original.id
  });
  project = originalPin.project;
  const translationPin = addSongResource(project, translation, {
    provider: 'pptx-service-import',
    itemId: translation.id
  });
  project = translationPin.project;
  project = addProjectItem(project, {
    id: 'translation-only-item',
    kind: 'song',
    title: translation.title,
    primaryChannelId: 'primary',
    variants: {
      primary: { mode: 'content', resourceId: translationPin.resourceId }
    },
    arrangement: [
      { id: 'translation-arr-1', sectionId: 'verse-1' },
      { id: 'translation-arr-2', sectionId: 'chorus' }
    ],
    titlePresetId: 'song-title',
    lyricsPresetId: 'song-lyrics'
  }, { now: '2026-08-23T12:00:00.000Z' });

  assert.deepEqual(
    reachableSongResources(project).map(resource => resource.document.id).sort(),
    [original.id, translation.id].sort()
  );
  const reconciled = reconcileServiceSongCatalog([
    { id: project.id, project }
  ]);
  assert.equal(reconciled.catalog.songs.length, 2);
  assert.deepEqual(
    reconciled.services[0].orderedSongSources.map(entry => entry.song.translationOf),
    [null, reconciled.services[0].orderedSongSources[0].song.id]
  );

  const root = await temporaryDirectory(t);
  const library = new LocalSongLibrary({ rootPath: path.join(root, 'song-library') });
  const hydration = await importPortableProjectSongs(reconciled.services[0].project, library);
  assert.equal(hydration.added, 2);
  assert.equal(hydration.failed, 0);
});
