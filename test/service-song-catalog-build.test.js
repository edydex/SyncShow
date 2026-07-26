'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  LocalSongLibrary,
  OUTPUT_ONLY_SONG_PROVIDER,
  addProjectItem,
  addSongResource,
  createServiceProject,
  importPortableProjectSongs,
  normalizeSongDocument
} = require('../src/services/project');
const {
  auditProjectTranslationCandidates,
  combinedProject,
  manifestForService,
  parseArguments,
  parseNormalizationSpec,
  projectAudit
} = require('../scripts/build-service-song-catalog');

function proposalSong(overrides = {}) {
  return {
    canonicalId: 'sample-bilingual-song',
    titles: {
      ru: 'Пример песни',
      en: 'Sample Song'
    },
    credits: {
      authors: ['A. Author'],
      composers: ['C. Composer'],
      translators: ['T. Translator'],
      raw: 'Words by A. Author; translation by T. Translator'
    },
    channels: {
      primary: {
        mode: 'content',
        deckRole: 'russian',
        includeColors: ['#FFFFFF'],
        catalog: true,
        documentId: 'sample-song-ru',
        language: 'ru',
        translationOf: 'sample-song-en'
      },
      secondary: {
        mode: 'content',
        deckRole: 'english',
        includeColors: ['#FFFF00'],
        catalog: true,
        documentId: 'sample-song-en',
        language: 'en',
        translationOf: null
      },
      singer: {
        mode: 'content',
        deckRole: 'singer',
        catalog: false,
        documentId: 'sample-song-singer',
        language: 'mul'
      }
    },
    sections: [
      {
        id: 'part-01',
        marker: 'P1',
        label: 'Part 1 (provisional)',
        slides: { default: 3 }
      },
      {
        id: 'part-02',
        marker: 'P2',
        label: 'Part 2 (provisional)',
        slides: { default: 4 }
      }
    ],
    arrangement: ['part-01', 'part-02', 'part-01'],
    review: {
      targetedTextNormalization: {
        status: 'proposed_for_review_not_applied',
        channelId: 'primary',
        mode: 'reviewed-script-normalization-v1',
        replacementCount: 7
      }
    },
    ...overrides
  };
}

function proposalService(song = proposalSong()) {
  return {
    id: 'service-2026-08-02',
    serviceDate: '2026-08-02',
    songs: [song]
  };
}

test('proposal conversion preserves structure, explicit translation direction, and scoped catalog policy', () => {
  const normalizations = new Map([[
    '2026-08-02:sample-bilingual-song:primary',
    {
      key: '2026-08-02:sample-bilingual-song:primary',
      serviceDate: '2026-08-02',
      songId: 'sample-bilingual-song',
      channelId: 'primary',
      mode: 'reviewed-script-normalization-v1',
      expectedReplacements: 7
    }
  ]]);
  const usedNormalizations = new Set();
  const manifest = manifestForService(proposalService(), {
    normalizations,
    usedNormalizations
  });
  const item = manifest.items.find(candidate => candidate.kind === 'song');

  assert.equal(item.primaryChannelId, 'secondary');
  assert.equal(item.channels.primary.song.translationOf, 'sample-song-en');
  assert.deepEqual(item.channels.primary.song.translators, ['T. Translator']);
  assert.equal(item.channels.secondary.song.translationOf, undefined);
  assert.equal(item.channels.secondary.song.translators, undefined);
  assert.deepEqual(item.channels.secondary.song.authors, ['A. Author']);
  assert.deepEqual(item.channels.secondary.song.composers, ['C. Composer']);
  assert.equal(
    item.channels.primary.textNormalization,
    'reviewed-script-normalization-v1'
  );
  assert.equal(item.channels.singer.catalog, false);
  assert.deepEqual(item.sections.map(section => section.id), ['part-01', 'part-02']);
  assert.deepEqual(item.arrangement, ['part-01', 'part-02', 'part-01']);
  assert.deepEqual([...usedNormalizations], [
    '2026-08-02:sample-bilingual-song:primary'
  ]);

  const serialized = JSON.stringify(manifest);
  assert.equal(serialized.includes('/Downloads/'), false);
  assert.equal(serialized.includes('"lyrics"'), false);
  assert.equal(serialized.includes('"lines"'), false);
});

test('reviewed text normalization needs an exact service, song, channel, and replacement count', () => {
  const spec = parseNormalizationSpec(
    '2026-08-02:sample-bilingual-song:primary=reviewed-script-normalization-v1:7'
  );
  assert.deepEqual(spec, {
    key: '2026-08-02:sample-bilingual-song:primary',
    serviceDate: '2026-08-02',
    songId: 'sample-bilingual-song',
    channelId: 'primary',
    mode: 'reviewed-script-normalization-v1',
    expectedReplacements: 7
  });

  const mismatched = new Map([[spec.key, { ...spec, expectedReplacements: 8 }]]);
  assert.throws(
    () => manifestForService(proposalService(), {
      normalizations: mismatched,
      usedNormalizations: new Set()
    }),
    /does not exactly match a reviewed proposal/
  );
  assert.throws(
    () => parseNormalizationSpec('sample-song=global-rewrite'),
    /must use DATE:SONG_ID:CHANNEL/
  );
});

test('argument parsing keeps expected counts and normalization approvals explicit', () => {
  const parsed = parseArguments([
    '--proposal', '/tmp/proposal.json',
    '--work-root', '/tmp/new-work',
    '--expected-occurrences', '28',
    '--expected-families', '27',
    '--expected-exact-reuse', '1',
    '--expected-translation-items', '15',
    '--normalization',
    '2026-08-02:sample-bilingual-song:primary=reviewed-script-normalization-v1:7'
  ]);
  assert.equal(parsed.expectedOccurrences, 28);
  assert.equal(parsed.expectedFamilies, 27);
  assert.equal(parsed.expectedExactReuse, 1);
  assert.equal(parsed.expectedTranslationItems, 15);
  assert.equal(parsed.normalizations.size, 1);
});

function sourceProject(serviceId, serviceDate, itemSuffix, { outputOnly = false } = {}) {
  let project = createServiceProject({
    id: `downloaded-songs-${serviceDate}`,
    title: serviceId,
    serviceDate,
    preferredProfileId: 'default',
    channels: [
      { id: 'primary', label: 'Russian', language: 'ru' },
      { id: 'secondary', label: 'English', language: 'en' },
      { id: 'singer', label: 'Singers', language: 'mul' }
    ],
    now: `${serviceDate}T12:00:00.000Z`
  });
  const song = normalizeSongDocument({
    schemaVersion: 1,
    id: `${serviceId}-song`,
    title: `Song ${itemSuffix}`,
    language: 'ru',
    sections: [{
      id: 'part-01',
      marker: 'P1',
      label: 'Part 1',
      slides: [{ lines: [`Sample ${itemSuffix}`] }]
    }]
  });
  const primary = addSongResource(project, song, {
    provider: 'syncshow-song-catalog',
    itemId: song.id
  });
  project = primary.project;
  let singer = null;
  if (outputOnly) {
    singer = addSongResource(project, {
      ...song,
      id: `${serviceId}-singer`,
      language: 'mul',
      translationOf: song.id
    }, {
      provider: OUTPUT_ONLY_SONG_PROVIDER,
      itemId: `${serviceId}-singer`
    });
    project = singer.project;
  }
  return addProjectItem(project, {
    id: `${serviceId}-${itemSuffix}`,
    kind: 'song',
    title: song.title,
    primaryChannelId: 'primary',
    variants: {
      primary: { mode: 'content', resourceId: primary.resourceId },
      secondary: { mode: 'inherit', from: 'primary' },
      singer: outputOnly
        ? { mode: 'content', resourceId: singer.resourceId }
        : { mode: 'inherit', from: 'primary' }
    },
    arrangement: [{ id: `${serviceId}-arr-1`, sectionId: 'part-01' }],
    titlePresetId: 'song-title',
    lyricsPresetId: 'song-lyrics'
  }, { now: `${serviceDate}T12:00:00.000Z` });
}

test('combined project keeps every occurrence under its service date and pins output-only Singer content', () => {
  const first = sourceProject('service-a', '2026-08-02', 'first');
  const second = sourceProject('service-b', '2026-08-09', 'second', {
    outputOnly: true
  });
  const combined = combinedProject([
    { id: 'service-b', project: second },
    { id: 'service-a', project: first }
  ], new Map([
    ['service-a', '2026-08-02'],
    ['service-b', '2026-08-09']
  ]));
  const audit = projectAudit(combined);

  assert.equal(audit.groupCount, 2);
  assert.equal(audit.songOccurrenceCount, 2);
  assert.equal(audit.outputOnlyResourceCount, 1);
  assert.equal(audit.assetCount, 0);
  assert.deepEqual(audit.itemKinds, ['group', 'song']);
  assert.deepEqual(
    combined.rootItemIds,
    ['service-date-2026-08-02', 'service-date-2026-08-09']
  );
  assert.equal(audit.cueCount, 4);
});

test('translation candidate audit proves pinned bilingual items survive clean library hydration', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'syncshow-candidate-audit-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let project = createServiceProject({
    id: 'candidate-audit-service',
    title: 'Candidate audit service',
    serviceDate: '2026-08-16',
    preferredProfileId: 'default',
    channels: [
      { id: 'primary', label: 'Primary', language: 'ru' },
      { id: 'secondary', label: 'Secondary', language: 'en' },
      { id: 'singer', label: 'Singers', language: 'mul' }
    ],
    now: '2026-08-16T12:00:00.000Z'
  });
  const original = normalizeSongDocument({
    schemaVersion: 1,
    id: 'candidate-original',
    title: 'Candidate Original',
    language: 'ru',
    sections: [{
      id: 'verse-1',
      marker: '1',
      label: 'Verse 1',
      slides: [{ lines: ['Original line'] }]
    }]
  });
  const translation = normalizeSongDocument({
    ...original,
    id: 'candidate-translation',
    title: 'Candidate Translation',
    language: 'en',
    translationOf: original.id,
    sections: [{
      ...original.sections[0],
      slides: [{ lines: ['Translated line'] }]
    }]
  });
  const originalPin = addSongResource(project, original, {
    provider: 'syncshow-song-catalog',
    itemId: original.id
  });
  project = originalPin.project;
  const translationPin = addSongResource(project, translation, {
    provider: 'syncshow-song-catalog',
    itemId: translation.id
  });
  project = translationPin.project;
  project = addProjectItem(project, {
    id: 'candidate-song-item',
    kind: 'song',
    title: original.title,
    primaryChannelId: 'primary',
    variants: {
      primary: { mode: 'content', resourceId: originalPin.resourceId },
      secondary: { mode: 'content', resourceId: translationPin.resourceId },
      singer: { mode: 'inherit', from: 'primary' }
    },
    arrangement: [{ id: 'candidate-arrangement-1', sectionId: 'verse-1' }],
    titlePresetId: 'song-title',
    lyricsPresetId: 'song-lyrics'
  }, { now: '2026-08-16T12:00:00.000Z' });

  const library = new LocalSongLibrary({ rootPath: path.join(root, 'song-library') });
  const hydration = await importPortableProjectSongs(project, library);
  assert.equal(hydration.added, 2);
  assert.deepEqual(
    await auditProjectTranslationCandidates(project, library),
    {
      expectedItemCount: 1,
      candidateItemCount: 1,
      candidateOptionCount: 1,
      missingItemIds: []
    }
  );
});
