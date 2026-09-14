'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const {
  COMMUNITY_SERVICE_PLAN_KIND,
  communityServicePlanRevision,
  serializeCommunityServicePlan
} = require('../src/services/community/CommunityServicePlan');
const {
  CommunityServicePlanImportCoordinator,
  CommunityServicePlanImportError,
  MAX_COMMUNITY_PLAN_DIFF_ITEMS
} = require('../src/services/community/CommunityServicePlanImportCoordinator');
const {
  CommunitySermonSync
} = require('../src/services/community/CommunitySermonSync');
const {
  CommunitySyncStateStore
} = require('../src/services/community/CommunitySyncStateStore');
const {
  LocalSermonLibrary
} = require('../src/services/sermon/LocalSermonLibrary');
const {
  serializeSermonDocument
} = require('../src/services/sermon/SermonDocument');
const {
  ServiceProjectStore
} = require('../src/services/project/ServiceProjectStore');
const {
  ShowPackagePublisher,
  addBibleItem,
  addGroupItem,
  addProjectItem,
  addSermonResource,
  addSongResource,
  analyzeServiceProjectReadiness,
  applyCanonicalSermonBodyProjection,
  applySermonCueReconciliation,
  bindProjectAsPowerPointCompanion,
  bindCommunityServicePlanBaseline,
  bindProjectToServiceSet,
  buildCanonicalSermonBodyProjectionProposal,
  buildSermonCueReconciliationProposal,
  createCommunityServicePlanReconciliationReceipt,
  createServiceProject,
  moveProjectItem,
  normalizeServiceProject,
  parseSongDocument,
  removeProjectItemAndDescendants,
  repinSermonRevision,
  resolveSermonSourceLink,
  sermonDocumentSha256,
  serviceProjectRevisionId,
  setSermonSourceLink,
  setServicePlanStatus,
  updateGroupItem,
  updatePresentationItem,
  updateSongArrangement,
  upgradeSermonDocument
} = require('../src/services/project');
const {
  communityServicePlanBaselineFromProject
} = require('../src/services/community/CommunityServicePlanBaseline');
const {
  buildCommunityServicePlanReconciliation,
  reconciliationProjectSha256
} = require('../src/services/community/CommunityServicePlanReconciliation');
const {
  applyPlanLinkedPowerPointHandoff,
  derivePlanLinkedPowerPointHandoff
} = require('../src/services/show/PlanLinkedPowerPointHandoff');
const {
  buildServiceSermonPacketSourcePlan,
  serviceSermonPacketSourceDispositions
} = require('../src/services/sermon/ServiceSermonPacket');

const NOW = '2026-07-28T19:00:00.000Z';
const SONG_RECORD_REVISION = 'song:song-family-grace:7';
const SONG_FAMILY_REVISION = 'e'.repeat(64);
const SERMON_REVISION = 'b'.repeat(64);
const ROOT_SONG_REVISION = 'c'.repeat(64);
const RUSSIAN_SONG_REVISION = 'd'.repeat(64);
const FONT_PATH = path.resolve(__dirname, '../assets/fonts/NotoSans-Variable.ttf');
const PPTX_MEDIA_TYPE =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation';

async function tempDirectory(t) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'syncshow-community-plan-import-')
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return fs.realpath(directory);
}

function songDocument({
  id = 'grace-alone',
  title = 'Grace Alone',
  language = 'en',
  translationOf = null,
  line = 'Grace alone, which God supplies'
} = {}) {
  return parseSongDocument([
    '---',
    `id: ${id}`,
    `title: ${title}`,
    `language: ${language}`,
    ...(translationOf ? [`translationOf: ${translationOf}`] : []),
    '---',
    '^1',
    line,
    '^chorus',
    'Christ in me'
  ].join('\n'));
}

function sermonDocument({
  publicationStatus = 'draft',
  references = []
} = {}) {
  return {
    schemaVersion: 2,
    kind: 'syncshow-sermon',
    id: 'sermon-prayer',
    titles: { en: 'The Prayer That Transforms the Church' },
    defaultLanguage: 'en',
    speaker: { id: null, name: 'Pastor Example' },
    serviceDate: '2026-08-02',
    series: null,
    outline: [],
    sources: [],
    references,
    media: [],
    publication: {
      status: publicationStatus,
      visibility: 'private',
      publishedAt: null,
      canonicalUrl: null
    }
  };
}

function sermonReference({
  id = 'primary-eph-3',
  role = 'primary',
  reviewStatus = 'confirmed',
  startVerse = null,
  endVerse = null
} = {}) {
  return {
    id,
    range: {
      schemaVersion: 1,
      bookId: 'Eph',
      start: { chapter: 3, verse: startVerse },
      end: { chapter: 3, verse: endVerse }
    },
    role,
    source: 'operator',
    reviewStatus,
    enteredText: startVerse === null
      ? 'Ephesians 3'
      : `Ephesians 3:${startVerse}-${endVerse}`,
    sourceId: null,
    sectionId: null,
    startOffset: null,
    endOffset: null
  };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function canonicalHash(value) {
  return crypto.createHash('sha256')
    .update(`${canonicalJson(value)}\n`)
    .digest('hex');
}

function stableHash(value) {
  return crypto.createHash('sha256')
    .update(canonicalJson(value))
    .digest('hex');
}

function managedItemId(entryId) {
  return `community-item-${
    crypto.createHash('sha256').update(entryId).digest('hex').slice(0, 40)
  }`;
}

function projectItemParentId(project, itemId) {
  if (project.rootItemIds.includes(itemId)) return null;
  for (const item of Object.values(project.items)) {
    if (item.kind === 'group' && item.childIds.includes(itemId)) {
      return item.id;
    }
  }
  return undefined;
}

function legacyBaselineV1(rawBaseline) {
  const entries = rawBaseline.entries.map(entry => {
    const legacyEntry = { ...entry };
    delete legacyEntry.contentSpecSha256;
    delete legacyEntry.relationshipSha256;
    delete legacyEntry.dependentStateSha256;
    delete legacyEntry.titleSha256;
    return legacyEntry;
  });
  const projection = {
    schemaVersion: 1,
    kind: rawBaseline.kind,
    planRevision: rawBaseline.planRevision,
    channelContractSha256: rawBaseline.channelContractSha256,
    metadata: rawBaseline.metadata,
    entries,
    containers: rawBaseline.containers
  };
  return {
    ...projection,
    projectionSha256: stableHash(projection)
  };
}

function sermonSyncEnvelope(document, syncVersion) {
  const documentSource = serializeSermonDocument(document);
  return {
    syncId: document.id,
    syncVersion,
    revision: crypto.createHash('sha256')
      .update(documentSource)
      .digest('hex'),
    documentSource,
    archived: document.publication.status === 'archived',
    updatedAt: NOW,
    sourceObjects: document.sources.map(source => ({
      sourceId: source.id,
      sha256: source.sha256,
      sizeBytes: source.sizeBytes,
      available: false
    }))
  };
}

function sourceExtractionSnapshot({
  sermon,
  sermonRevisionId,
  sourceId,
  texts
}) {
  const source = sermon.sources.find(candidate => candidate.id === sourceId);
  assert.ok(source, `expected sermon source ${sourceId}`);
  const units = texts.map((text, index) => ({
    id: `${source.id}-slide-${index + 1}`,
    kind: 'slide',
    ordinal: index + 1,
    label: `${source.fileName} · Slide ${index + 1}`,
    text,
    truncated: false
  }));
  const extraction = {
    schemaVersion: 1,
    kind: 'syncshow-sermon-source-extraction-proposal',
    extractor: {
      id: 'syncshow-deterministic-source-extractor',
      version: 1
    },
    source: {
      id: source.id,
      sha256: source.sha256,
      kind: source.kind,
      languages: source.languages,
      mediaType: source.mediaType
    },
    units,
    textPreview: texts.join('\n\n'),
    suggestionScope: {
      strategy: 'pptx-roman-outline-window',
      startUnitId: units[0].id,
      endUnitId: units[units.length - 1].id,
      startOrdinal: 1,
      endOrdinal: units.length
    },
    outlineSuggestions: ['I', 'II', 'III'].map((marker, index) => ({
      id: `outline-${source.id}-${marker.toLowerCase()}`,
      level: 1,
      marker,
      parentId: null,
      parentSuggestionId: null,
      suggestedKind: 'section',
      titles: { [source.languages[0]]: `${marker}. Point` },
      rawText: `${marker}. Point`,
      sourceUnitIds: [units[index].id],
      sourceUnitIdsTruncated: false,
      occurrenceCount: 1
    })),
    scriptureReferenceSuggestions: [],
    truncated: {
      units: false,
      text: false,
      preview: false,
      outlineSuggestions: false,
      scriptureReferences: false
    }
  };
  const binding = {
    sermonId: sermon.id,
    baseSermonRevisionId: sermonRevisionId,
    sourceId: source.id,
    sourceSha256: source.sha256,
    sourceKind: source.kind,
    extractorId: extraction.extractor.id,
    extractorVersion: extraction.extractor.version
  };
  const record = {
    schemaVersion: 1,
    kind: 'syncshow-sermon-extraction-snapshot',
    binding,
    extraction
  };
  return {
    snapshotHash: canonicalHash(record),
    binding,
    extraction
  };
}

function insertEveryReconciliationRow(proposal) {
  return proposal.rows.map(row => ({
    rowId: row.id,
    action: 'insert',
    targetItemId: null,
    sectionId: null,
    unitsByChannel: Object.fromEntries(
      proposal.channelIds.map(channelId => {
        const suggestion = row.suggestionsByChannel[channelId];
        return [
          channelId,
          suggestion
            ? { unitId: suggestion.unitId, text: suggestion.text }
            : null
        ];
      })
    )
  }));
}

function sourceDocumentFromImportPlan(importPlan) {
  return {
    id: importPlan.importOptions.id,
    kind: importPlan.importOptions.kind,
    fileName: importPlan.expected.fileName,
    mediaType: importPlan.expected.mediaType,
    sha256: importPlan.expected.sha256,
    sizeBytes: importPlan.expected.sizeBytes,
    provenance: { ...importPlan.importOptions.provenance },
    languages: [...importPlan.importOptions.languages]
  };
}

function plan(overrides = {}) {
  return {
    schemaVersion: 1,
    kind: COMMUNITY_SERVICE_PLAN_KIND,
    id: 'service-2026-08-02',
    title: 'Sunday Service — August 2',
    serviceDate: '2026-08-02',
    startTime: '10:30',
    teamNotes: 'Sound check at 09:45.',
    entries: [{
      id: 'opening',
      kind: 'section',
      title: 'Opening'
    }, {
      id: 'song-grace',
      kind: 'song',
      title: 'Grace Alone',
      syncId: 'song-family-grace',
      expectedRevision: SONG_RECORD_REVISION,
      expectedSyncVersion: 7
    }, {
      id: 'reading',
      kind: 'scripture',
      title: 'Ephesians 3:14–15',
      range: {
        schemaVersion: 1,
        bookId: 'Eph',
        start: { chapter: 3, verse: 14 },
        end: { chapter: 3, verse: 15 }
      },
      translationId: 'BSB'
    }, {
      id: 'sermon',
      kind: 'sermon',
      title: 'The Prayer That Transforms the Church',
      syncId: 'sermon-prayer',
      expectedRevision: SERMON_REVISION,
      expectedSyncVersion: 4
    }],
    ...overrides
  };
}

function planV2(overrides = {}) {
  const legacy = plan();
  return {
    ...legacy,
    schemaVersion: 2,
    entries: legacy.entries.map(entry => entry.kind === 'scripture'
      ? {
          ...entry,
          sermonReading: {
            sermonEntryId: 'sermon',
            referenceId: 'primary-eph-3'
          }
        }
      : entry),
    ...overrides
  };
}

function envelope(rawPlan = plan(), {
  status = 'ready',
  syncVersion = 3
} = {}) {
  const documentSource = serializeCommunityServicePlan(rawPlan);
  return {
    syncId: rawPlan.id,
    syncVersion,
    revision: communityServicePlanRevision(documentSource),
    documentSource,
    status,
    changedAt: NOW
  };
}

function biblePassage() {
  return {
    translation: {
      id: 'BSB',
      suggestedCredit: 'Berean Standard Bible'
    },
    bookId: 'Eph',
    book: 'Ephesians',
    chapter: 3,
    verseStart: 14,
    verseEnd: 15,
    reference: 'Ephesians 3:14–15',
    verses: [
      { number: 14, text: 'For this reason I bow my knees.' },
      { number: 15, text: 'From whom every family is named.' }
    ]
  };
}

function songDocumentWithSections(sectionMarkers, {
  id = 'grace-alone',
  title = 'Grace Alone',
  language = 'en',
  translationOf = null
} = {}) {
  return parseSongDocument([
    '---',
    `id: ${id}`,
    `title: ${title}`,
    `language: ${language}`,
    ...(translationOf ? [`translationOf: ${translationOf}`] : []),
    '---',
    ...sectionMarkers.flatMap(marker => [
      `^${marker}`,
      `${marker} words`
    ])
  ].join('\n'));
}

function mutableSongCatalog() {
  const catalog = {
    rootSong: songDocument(),
    rootRevision: ROOT_SONG_REVISION,
    russianSong: songDocument({
      id: 'grace-alone-ru',
      title: 'Только благодать',
      language: 'ru',
      translationOf: 'grace-alone',
      line: 'Только благодать'
    }),
    russianRevision: RUSSIAN_SONG_REVISION,
    familyRevision: SONG_FAMILY_REVISION
  };
  return {
    catalog,
    snapshotProvider() {
      return {
        familyId: 'grace-alone',
        snapshotHash: 'f'.repeat(64),
        familyRevision: catalog.familyRevision,
        documents: [{
          songId: 'grace-alone',
          revision: catalog.rootRevision,
          translationOf: null
        }, {
          songId: 'grace-alone-ru',
          revision: catalog.russianRevision,
          translationOf: 'grace-alone'
        }]
      };
    },
    revisionProvider(songId, revision) {
      if (songId === 'grace-alone' && revision === catalog.rootRevision) {
        return { song: catalog.rootSong, revision };
      }
      if (
        songId === 'grace-alone-ru'
        && revision === catalog.russianRevision
      ) {
        return { song: catalog.russianSong, revision };
      }
      throw new Error(`missing exact song revision ${songId}:${revision}`);
    }
  };
}

async function harness(t, {
  songState = {},
  sermonState = {},
  publicationStatus = 'draft',
  sermonReferences = [],
  bibleFailure = false,
  clock = () => new Date(NOW),
  songSnapshotProvider = null,
  songRevisionProvider = null,
  sermonStateProvider = null,
  sermonRevisionProvider = null,
  biblePassageProvider = null
} = {}) {
  const rootPath = await tempDirectory(t);
  const projectStore = new ServiceProjectStore({
    rootPath,
    clock
  });
  let snapshotCalls = 0;
  let bibleCalls = 0;
  const rootSong = songDocument();
  const russianSong = songDocument({
    id: 'grace-alone-ru',
    title: 'Только благодать',
    language: 'ru',
    translationOf: 'grace-alone',
    line: 'Только благодать'
  });
  const coordinator = new CommunityServicePlanImportCoordinator({
    serverId: 'wotbc-community',
    connectionId: 'connection-1',
    projectStore,
    syncStateStore: {
      async getSongState(syncIdConnection, syncId) {
        assert.equal(syncIdConnection, 'connection-1');
        assert.equal(syncId, 'song-family-grace');
        return {
          syncId,
          localFamilyId: 'grace-alone',
          syncVersion: 7,
          remoteRevision: SONG_RECORD_REVISION,
          documents: {
            'grace-alone': {
              localRevision: ROOT_SONG_REVISION,
              remoteRevision: ROOT_SONG_REVISION
            },
            'grace-alone-ru': {
              localRevision: RUSSIAN_SONG_REVISION,
              remoteRevision: RUSSIAN_SONG_REVISION
            }
          },
          archived: false,
          metadataOnly: false,
          conflict: null,
          ...songState
        };
      },
      async getSermonState(syncIdConnection, syncId) {
        assert.equal(syncIdConnection, 'connection-1');
        if (sermonStateProvider) {
          return sermonStateProvider(syncId);
        }
        assert.equal(syncId, 'sermon-prayer');
        return {
          syncId,
          localSermonId: 'sermon-prayer',
          syncVersion: 4,
          localRevision: SERMON_REVISION,
          remoteRevision: SERMON_REVISION,
          conflict: null,
          ...sermonState
        };
      }
    },
    songLibrary: {
      async withCurrentSnapshot(operation) {
        snapshotCalls += 1;
        return operation({
          async snapshotFamily(familyId) {
            assert.equal(familyId, 'grace-alone');
            if (songSnapshotProvider) {
              return songSnapshotProvider(familyId);
            }
            return {
              familyId,
              snapshotHash: 'f'.repeat(64),
              familyRevision: SONG_FAMILY_REVISION,
              documents: [{
                songId: 'grace-alone',
                revision: ROOT_SONG_REVISION,
                translationOf: null
              }, {
                songId: 'grace-alone-ru',
                revision: RUSSIAN_SONG_REVISION,
                translationOf: 'grace-alone'
              }]
            };
          },
          async readRevision(songId, revision) {
            if (songRevisionProvider) {
              return songRevisionProvider(songId, revision);
            }
            if (songId === 'grace-alone'
              && revision === ROOT_SONG_REVISION) {
              return { song: rootSong, revision };
            }
            if (songId === 'grace-alone-ru'
              && revision === RUSSIAN_SONG_REVISION) {
              return { song: russianSong, revision };
            }
            throw new Error('missing exact song revision');
          }
        });
      }
    },
    sermonLibrary: {
      async readRevision(sermonId, revision) {
        if (sermonRevisionProvider) {
          return sermonRevisionProvider(sermonId, revision);
        }
        assert.equal(sermonId, 'sermon-prayer');
        assert.equal(revision, SERMON_REVISION);
        return {
          sermon: sermonDocument({
            publicationStatus,
            references: sermonReferences
          }),
          revision
        };
      }
    },
    async bibleResolver({ channelIds, translationId }) {
      bibleCalls += 1;
      assert.equal(translationId, 'BSB');
      if (bibleFailure) throw new Error('translation unavailable');
      return {
        passagesByChannel: Object.fromEntries(
          channelIds.map(channelId => [
            channelId,
            biblePassageProvider
              ? biblePassageProvider({
                  channelId,
                  call: bibleCalls,
                  translationId
                })
              : biblePassage()
          ])
        )
      };
    },
    clock
  });
  const options = {
    profileId: 'main-sanctuary',
    channels: [
      { id: 'primary', label: 'English', language: 'en' },
      { id: 'secondary', label: 'Russian', language: 'ru' }
    ]
  };
  return {
    coordinator,
    projectStore,
    rootPath,
    options,
    counts: () => ({ snapshotCalls, bibleCalls })
  };
}

function expectImportCode(code) {
  return error => {
    assert.ok(error instanceof CommunityServicePlanImportError);
    assert.equal(error.code, code);
    return true;
  };
}

test('ready plan imports one ordered offline project with exact local pins and v2 provenance', async t => {
  const { coordinator, projectStore, options, counts } = await harness(t);
  const remote = envelope();

  const proposal = await coordinator.propose(remote, options);
  assert.equal(proposal.status, 'ready-to-import');
  assert.equal(proposal.remoteStatus, 'ready');
  assert.equal(proposal.blockerCount, 0);
  assert.equal(Object.keys(proposal).some(key => key.startsWith('_')), false);

  const imported = await coordinator.importPlan(remote, options);
  assert.equal(imported.status, 'imported');
  const project = imported.project;
  const openingId = project.rootItemIds[0];
  assert.equal(project.items[openingId].title, 'Opening');
  assert.deepEqual(
    project.items[openingId].childIds.map(itemId => project.items[itemId].kind),
    ['song', 'bible', 'group']
  );
  assert.equal(
    project.items[project.items[openingId].childIds[2]].groupKind,
    'sermon'
  );
  assert.equal(
    Object.hasOwn(
      project.items[project.items[openingId].childIds[1]],
      'sermonReading'
    ),
    false
  );
  assert.deepEqual(project.planning.source, {
    kind: 'community-plan',
    serverId: 'wotbc-community',
    planId: remote.syncId,
    planRevision: remote.revision,
    importedAt: NOW
  });
  assert.equal(project.planning.startTime, '10:30');
  assert.equal(project.planning.teamNotes, 'Sound check at 09:45.');
  const origins = Object.values(project.resources)
    .map(resource => resource.origin)
    .sort((left, right) => left.itemId.localeCompare(right.itemId));
  assert.deepEqual(origins.map(origin => ({
    provider: origin.provider,
    itemId: origin.itemId,
    revision: origin.revision
  })), [{
    provider: 'local-song-library',
    itemId: 'grace-alone',
    revision: ROOT_SONG_REVISION
  }, {
    provider: 'local-song-library',
    itemId: 'grace-alone-ru',
    revision: RUSSIAN_SONG_REVISION
  }, {
    provider: 'local-sermon-library',
    itemId: 'sermon-prayer',
    revision: SERMON_REVISION
  }]);

  const beforeCounts = counts();
  const repeated = await coordinator.importPlan(remote, options);
  assert.equal(repeated.status, 'already-imported');
  assert.equal(repeated.unchanged, true);
  assert.equal(repeated.revisionId, imported.revisionId);
  assert.deepEqual(counts(), beforeCounts);
  assert.equal(
    (await projectStore.listRevisions(imported.projectId)).total,
    1
  );
});

test('v2 imports one linked reading before its sermon and reuses one exact resource', async t => {
  const { coordinator, options } = await harness(t, {
    sermonReferences: [sermonReference()]
  });
  const imported = await coordinator.importPlan(envelope(planV2()), options);
  const project = imported.project;
  const opening = project.items[project.rootItemIds[0]];
  const ordered = opening.childIds.map(itemId => project.items[itemId]);

  assert.deepEqual(ordered.map(item => item.kind), ['song', 'bible', 'group']);
  assert.equal(
    Object.values(project.items).filter(item => item.kind === 'bible').length,
    1
  );
  assert.deepEqual(ordered[1].sermonReading, {
    sermonResourceId: ordered[2].sermonResourceId,
    referenceId: 'primary-eph-3',
    translationId: 'BSB',
    chunkIndex: 0,
    chunkCount: 1
  });
  assert.equal(
    project.resources[ordered[1].sermonReading.sermonResourceId].document.id,
    'sermon-prayer'
  );
});

test('v2 Community plan composes through reviewed linked-sermon contracts into a ready immutable ShowPackage', async t => {
  const {
    coordinator,
    projectStore,
    rootPath,
    options,
    counts
  } = await harness(t, {
    sermonReferences: [sermonReference()]
  });
  const remote = envelope(planV2());
  const imported = await coordinator.importPlan(remote, options);
  const importedProject = imported.project;
  const opening = importedProject.items[importedProject.rootItemIds[0]];
  const reading = opening.childIds
    .map(itemId => importedProject.items[itemId])
    .find(item => item.kind === 'bible');
  const sermonGroup = opening.childIds
    .map(itemId => importedProject.items[itemId])
    .find(item => item.kind === 'group' && item.groupKind === 'sermon');
  const originalResourceId = sermonGroup.sermonResourceId;
  const originalSermon =
    importedProject.resources[originalResourceId].document;
  const originalReferenceId = reading.sermonReading.referenceId;
  const remoteReadCounts = counts();

  const manifest = {
    schemaVersion: 1,
    id: 'service-set-2026-08-02',
    name: 'Sunday Service — August 2',
    profileId: 'main-sanctuary',
    serviceDate: '2026-08-02',
    createdAt: NOW,
    inputs: {
      english: {
        roleId: 'english',
        assetId: `sha256:${'1'.repeat(64)}`,
        sourceName: '08-02 ENG.pptx',
        pinnedPath: path.join(rootPath, 'private', '08-02 ENG.pptx'),
        size: 4096,
        sha256: '1'.repeat(64)
      },
      russian: {
        roleId: 'russian',
        assetId: `sha256:${'2'.repeat(64)}`,
        sourceName: '08-02 RUS.pptx',
        pinnedPath: path.join(rootPath, 'private', '08-02 RUS.pptx'),
        size: 4097,
        sha256: '2'.repeat(64)
      }
    }
  };
  const sourceIds = [
    'source-service-english',
    'source-service-russian',
    'source-pastor-manuscript'
  ];
  const sourcePlan = buildServiceSermonPacketSourcePlan({
    manifest,
    manuscript: {
      fileName: 'Pastor manuscript.docx',
      mediaType:
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      sha256: '3'.repeat(64),
      sizeBytes: 8192,
      defaultKind: 'manuscript'
    },
    manuscriptPath: path.join(rootPath, 'private', 'Pastor manuscript.docx'),
    manuscriptLanguages: ['en'],
    manuscriptProvidedBy: 'Pastor Example',
    receivedAt: NOW,
    createSourceId: () => sourceIds.shift()
  });
  const dispositions = serviceSermonPacketSourceDispositions(
    originalSermon,
    sourcePlan
  );
  assert.deepEqual(
    dispositions.map(source => [source.key, source.disposition]),
    [
      ['service:english', 'add'],
      ['service:russian', 'add'],
      ['manuscript', 'add']
    ]
  );
  assert.doesNotMatch(
    JSON.stringify(sourcePlan.publicSources),
    /(?:sourcePath|pinnedPath|\/private\/|[A-Za-z]:\\)/u
  );

  // Real-byte import, extraction-store, transaction, and Electron proposal/CAS
  // boundaries have focused tests; this test composes their public contracts.
  const attachedSources = sourcePlan.importPlans
    .map(sourceDocumentFromImportPlan);
  const upgradedSermon = upgradeSermonDocument(originalSermon);
  const attachedSermon = {
    ...upgradedSermon,
    sources: [...upgradedSermon.sources, ...attachedSources]
  };
  const attachedSermonRevisionId = sermonDocumentSha256(attachedSermon);
  let attachedProject = bindProjectToServiceSet(importedProject, {
    id: manifest.id,
    fingerprint: sourcePlan.serviceSetFingerprint,
    serviceDate: manifest.serviceDate,
    profileId: manifest.profileId
  });
  const embedded = addSermonResource(attachedProject, attachedSermon, {
    provider: 'local-sermon-library',
    itemId: attachedSermon.id,
    revision: attachedSermonRevisionId
  });
  attachedProject = repinSermonRevision(embedded.project, {
    previousResourceId: originalResourceId,
    nextResourceId: embedded.resourceId,
    now: NOW
  });
  const attached = await projectStore.save(attachedProject, {
    expectedRevisionId: imported.revisionId,
    reason: 'attach-linked-sermon-service-sources'
  });

  const attachedReading = attached.project.items[reading.id];
  const attachedGroup = attached.project.items[sermonGroup.id];
  assert.equal(attachedGroup.sermonResourceId, embedded.resourceId);
  assert.equal(
    attachedReading.sermonReading.sermonResourceId,
    embedded.resourceId
  );
  assert.equal(
    attachedReading.sermonReading.referenceId,
    originalReferenceId
  );
  assert.equal(
    attached.project.resources[embedded.resourceId].document.id,
    originalSermon.id
  );
  assert.equal(
    new Set(attachedSources.map(source => source.sha256)).size,
    attachedSources.length
  );
  assert.equal(
    attachedSources.filter(source =>
      source.mediaType === PPTX_MEDIA_TYPE).length,
    2
  );
  assert.deepEqual(
    counts(),
    remoteReadCounts,
    'local source attachment must not write to or refresh Community'
  );

  const serviceSetClaim = {
    id: manifest.id,
    fingerprint: sourcePlan.serviceSetFingerprint,
    serviceDate: manifest.serviceDate,
    profileId: manifest.profileId,
    roles: Object.values(manifest.inputs).map(input => ({
      roleId: input.roleId,
      assetId: input.assetId
    }))
  };
  const planLinkedHandoff = derivePlanLinkedPowerPointHandoff({
    sourceProject: attached.project,
    sourceProjectRevisionId: attached.revisionId,
    sourceItemId: sermonGroup.id,
    serviceSet: serviceSetClaim
  });
  let companionProject = createServiceProject({
    id: 'pptx-companion-service-set-2026-08-02',
    title: manifest.name,
    serviceDate: manifest.serviceDate,
    profileId: manifest.profileId,
    channels: options.channels,
    now: NOW
  });
  companionProject = addGroupItem(companionProject, {
    id: 'pptx-sermon-anchor',
    title: 'Sermon',
    groupKind: 'sermon',
    now: NOW
  });
  companionProject = bindProjectAsPowerPointCompanion(
    companionProject,
    {
      id: manifest.id,
      fingerprint: sourcePlan.serviceSetFingerprint,
      serviceDate: manifest.serviceDate,
      profileId: manifest.profileId
    }
  );
  const linkedCompanion = applyPlanLinkedPowerPointHandoff({
    companionProject,
    anchorItemId: 'pptx-sermon-anchor',
    sourceProject: attached.project,
    handoff: planLinkedHandoff,
    now: NOW
  });
  const savedCompanion = await projectStore.save(linkedCompanion.project, {
    expectedRevisionId: null,
    reason: 'community-plan-pptx-link'
  });
  const companionSermon = resolveSermonSourceLink(
    savedCompanion.project,
    savedCompanion.project.items['pptx-sermon-anchor']
  );
  assert.equal(companionSermon.resource.document.id, originalSermon.id);
  assert.equal(companionSermon.resource.sha256, attachedSermonRevisionId);
  assert.equal(companionSermon.resourceId, embedded.resourceId);
  assert.deepEqual(
    counts(),
    remoteReadCounts,
    'linking the PowerPoint companion must remain local'
  );

  const englishSlides = attachedSources.find(source =>
    source.kind === 'slide-notes' && source.languages.includes('en'));
  const russianSlides = attachedSources.find(source =>
    source.kind === 'slide-notes' && source.languages.includes('ru'));
  assert.ok(englishSlides);
  assert.ok(russianSlides);
  const reconciliation = buildSermonCueReconciliationProposal({
    project: attached.project,
    projectRevisionId: attached.revisionId,
    anchorItemId: sermonGroup.id,
    sermonId: attachedSermon.id,
    sermonRevisionId: attachedSermonRevisionId,
    sourceMappings: [{
      channelId: 'primary',
      snapshot: sourceExtractionSnapshot({
        sermon: attachedSermon,
        sermonRevisionId: attachedSermonRevisionId,
        sourceId: englishSlides.id,
        texts: [
          'I. The church bows before the Father.',
          'II. The church is strengthened through the Spirit.',
          'III. The church displays the fullness of Christ.'
        ]
      })
    }, {
      channelId: 'secondary',
      snapshot: sourceExtractionSnapshot({
        sermon: attachedSermon,
        sermonRevisionId: attachedSermonRevisionId,
        sourceId: russianSlides.id,
        texts: [
          'I. Церковь преклоняется перед Отцом.',
          'II. Церковь укрепляется Духом.',
          'III. Церковь являет полноту Христа.'
        ]
      })
    }],
    now: NOW
  });
  const reconciled = applySermonCueReconciliation({
    project: attached.project,
    proposal: reconciliation,
    decisions: insertEveryReconciliationRow(reconciliation),
    confirmed: true,
    idFactory: ({ rowId }) => `community-sermon-${rowId}`
  });
  const prepared = await projectStore.save(reconciled.project, {
    expectedRevisionId: attached.revisionId,
    reason: 'review-community-linked-sermon-cues'
  });
  const readiness = analyzeServiceProjectReadiness(prepared.project);
  assert.equal(readiness.ready, true);
  assert.deepEqual(readiness.blockers, []);
  assert.deepEqual(
    readiness.checks.map(check => [check.id, check.status]),
    [
      ['compilable-nonempty', 'pass'],
      ['song-present', 'pass'],
      ['exact-sermon-link', 'pass'],
      ['linked-sermon-material', 'pass'],
      ['sermon-reading-before-material', 'pass'],
      ['channel-visible-content', 'pass']
    ]
  );
  assert.equal(readiness.sermons.length, 1);
  assert.equal(readiness.sermons[0].sermonId, originalSermon.id);
  assert.equal(
    readiness.sermons[0].sermonRevisionId,
    attachedSermonRevisionId
  );
  assert.deepEqual(
    readiness.sermons[0].qualifyingReadingItemIds,
    [reading.id]
  );
  const ready = await projectStore.save(
    setServicePlanStatus(prepared.project, 'ready'),
    {
      expectedRevisionId: prepared.revisionId,
      reason: 'mark-community-service-ready'
    }
  );
  assert.equal(
    analyzeServiceProjectReadiness(ready.project).ready,
    true
  );

  const publisher = new ShowPackagePublisher({
    projectStore,
    rootPath: path.join(rootPath, 'show-packages'),
    fontPath: FONT_PATH,
    clock: () => new Date(NOW),
    randomUUID: () => '11111111-1111-4111-8111-111111111111'
  });
  const published = await publisher.publish({
    projectId: ready.project.id,
    revisionId: ready.revisionId,
    roleMapping: {
      main: 'primary',
      singers: 'secondary'
    },
    width: 640,
    height: 360,
    thumbnailWidth: 100,
    jpegQuality: 88
  });

  assert.equal(published.serviceHandoff.readiness.ready, true);
  assert.deepEqual(
    published.serviceHandoff.readiness.checks.map(check => check.status),
    Array(6).fill('pass')
  );
  assert.deepEqual(
    published.serviceHandoff.readiness.waivedCheckIds,
    []
  );
  assert.equal(
    published.serviceHandoff.project.revisionId,
    ready.revisionId
  );
  assert.deepEqual(ready.project.planning.source, {
    kind: 'community-plan',
    serverId: 'wotbc-community',
    planId: remote.syncId,
    planRevision: remote.revision,
    importedAt: NOW
  });
  assert.deepEqual(published.serviceHandoff.planning, {
    status: 'ready',
    startTime: '10:30',
    teamNotes: 'Sound check at 09:45.',
    readinessWaivers: [],
    serving: {
      schemaVersion: 1,
      assignments: []
    }
  });
  assert.equal(
    published.manifest.cueCount,
    published.serviceHandoff.cueIds.length
  );
  assert.ok(published.manifest.cueCount >= 6);
  const packagedTimeline = JSON.parse(
    await fs.readFile(
      path.join(published.packagePath, 'timeline.json'),
      'utf8'
    )
  );
  const linkedSermonCueIds = packagedTimeline.cueIds.filter(candidateId =>
    packagedTimeline.cues[candidateId].sourceReference?.id
      === originalSermon.id);
  assert.deepEqual(
    linkedSermonCueIds.map(cueId =>
      packagedTimeline.cues[cueId].kind),
    ['bible', 'sermon', 'sermon', 'sermon']
  );
  assert.deepEqual(
    packagedTimeline.cues[linkedSermonCueIds[0]].sourceReference,
    {
      type: 'sermon-reading',
      id: originalSermon.id,
      revision: attachedSermonRevisionId,
      sectionId: null,
      referenceId: originalReferenceId,
      translationId: 'BSB',
      chunkIndex: 0,
      chunkCount: 1
    }
  );
  for (const cueId of linkedSermonCueIds.slice(1)) {
    assert.deepEqual(packagedTimeline.cues[cueId].sourceReference, {
      type: 'sermon-library',
      id: originalSermon.id,
      revision: attachedSermonRevisionId,
      sectionId: null
    });
  }
  assert.doesNotMatch(
    JSON.stringify(published.serviceHandoff),
    /(?:sourcePath|pinnedPath|Pastor manuscript\.docx|08-02 ENG\.pptx)/u
  );
  const reopened = await publisher.open(published.manifest.id);
  assert.equal(reopened.manifestSha256, published.manifestSha256);
  assert.deepEqual(reopened.serviceHandoff, published.serviceHandoff);

  const postShowMatches = await projectStore.findByServiceSetBinding(
    {
      id: manifest.id,
      fingerprint: sourcePlan.serviceSetFingerprint,
      serviceDate: manifest.serviceDate,
      profileId: manifest.profileId
    },
    {
      limit: 2,
      workflowMode: 'pptx-companion'
    }
  );
  assert.equal(postShowMatches.length, 1);
  assert.equal(postShowMatches[0].project.id, savedCompanion.project.id);
  const reopenedCompanionSermon = resolveSermonSourceLink(
    postShowMatches[0].project,
    postShowMatches[0].project.items['pptx-sermon-anchor']
  );
  assert.equal(reopenedCompanionSermon.resource.document.id, originalSermon.id);
  assert.equal(
    reopenedCompanionSermon.resource.sha256,
    attachedSermonRevisionId
  );

  const relationships = await projectStore.listSermonServiceRelationships(
    originalSermon.id,
    { pageSize: 10, offset: 0 }
  );
  assert.deepEqual(
    relationships.items.map(item => item.workflowMode).sort(),
    ['native', 'pptx-companion']
  );
  assert.deepEqual(
    [...new Set(relationships.items.map(item => item.sermonId))],
    [originalSermon.id]
  );

  const syncRoot = path.join(rootPath, 'post-service-community-sync');
  const localSermonLibrary = new LocalSermonLibrary({
    rootPath: path.join(syncRoot, 'sermons'),
    clock: () => new Date(NOW)
  });
  const syncStateStore = new CommunitySyncStateStore({
    storageRoot: path.join(syncRoot, 'state'),
    now: () => new Date(NOW)
  });
  let remoteSermon = sermonSyncEnvelope(attachedSermon, 4);
  assert.equal(remoteSermon.revision, attachedSermonRevisionId);
  const syncCalls = { create: 0, update: [] };
  const communityClient = {
    async listSermonChanges() {
      return { items: [], nextCursor: null, hasMore: false };
    },
    async getSermon({ syncId }) {
      assert.equal(syncId, originalSermon.id);
      return remoteSermon;
    },
    async createSermon() {
      syncCalls.create += 1;
      throw new Error('the existing Community sermon must not be recreated');
    },
    async updateSermon(options) {
      syncCalls.update.push(options);
      assert.equal(options.syncId, originalSermon.id);
      assert.equal(options.expectedSyncVersion, 4);
      const document = JSON.parse(options.documentSource);
      assert.equal(document.id, originalSermon.id);
      remoteSermon = sermonSyncEnvelope(document, 5);
      return remoteSermon;
    }
  };
  const sermonSync = new CommunitySermonSync({
    client: communityClient,
    localLibrary: localSermonLibrary,
    stateStore: syncStateStore,
    connectionId: 'wotbc-community-sync',
    accessTokenProvider: async () =>
      'community-sermon-access-token-for-test-only',
    now: () => new Date(NOW)
  });
  const pulled = await sermonSync.pullSermon(originalSermon.id, {
    expectedSyncVersion: 4,
    expectedRevision: attachedSermonRevisionId
  });
  assert.equal(pulled.syncId, reopenedCompanionSermon.resource.document.id);
  const localBeforeLinks = await localSermonLibrary.read(originalSermon.id);
  const postServiceSermon = {
    ...localBeforeLinks.sermon,
    media: [{
      id: 'post-service:recording:en',
      kind: 'audio',
      status: 'ready',
      title: 'Sunday sermon recording',
      language: 'en',
      mediaType: 'audio/mpeg',
      fileName: null,
      sha256: null,
      sizeBytes: null,
      durationSeconds: 2484.5,
      url: 'https://church.example/sermons/prayer.mp3'
    }],
    publication: {
      ...localBeforeLinks.sermon.publication,
      canonicalUrl: 'https://church.example/sermons/prayer'
    }
  };
  const localAfterLinks = await localSermonLibrary.saveDocument(
    postServiceSermon,
    {
      expectedSermonId: reopenedCompanionSermon.resource.document.id,
      expectedRevision: localBeforeLinks.revision
    }
  );
  const pushed = await sermonSync.pushSermon(
    reopenedCompanionSermon.resource.document.id,
    {
      expectedSyncVersion: 4,
      expectedLocalRevision: localAfterLinks.revision
    }
  );
  assert.equal(pushed.operation, 'updated');
  assert.equal(pushed.syncId, originalSermon.id);
  assert.equal(syncCalls.create, 0);
  assert.equal(syncCalls.update.length, 1);
});

test('v2 preserves an explicitly unlinked Scripture row without local sermon metadata', async t => {
  const { coordinator, options } = await harness(t);
  const v2 = planV2();
  v2.entries.find(entry => entry.kind === 'scripture').sermonReading = null;
  const imported = await coordinator.importPlan(envelope(v2), options);
  const reading = Object.values(imported.project.items).find(item =>
    item.kind === 'bible');

  assert.ok(reading);
  assert.equal(Object.hasOwn(reading, 'sermonReading'), false);
});

test('v2 linked readings reject non-primary, unconfirmed, and non-containing exact references before mutation', async t => {
  const cases = [{
    label: 'different exact reference id',
    reference: sermonReference({ id: 'primary-eph-3-nearby' }),
    blockerCode: 'SERVICE_PLAN_SERMON_READING_REFERENCE_MISSING'
  }, {
    label: 'mentioned reference',
    reference: sermonReference({ role: 'mentioned' }),
    blockerCode: 'SERVICE_PLAN_SERMON_READING_REFERENCE_NOT_PRIMARY'
  }, {
    label: 'unconfirmed reference',
    reference: sermonReference({ reviewStatus: 'suggested' }),
    blockerCode: 'SERVICE_PLAN_SERMON_READING_REFERENCE_UNCONFIRMED'
  }, {
    label: 'reading outside reference',
    reference: sermonReference({ startVerse: 1, endVerse: 8 }),
    blockerCode: 'SERVICE_PLAN_SERMON_READING_RANGE_MISMATCH'
  }];

  for (const candidate of cases) {
    await t.test(candidate.label, async t => {
      const {
        coordinator,
        projectStore,
        options
      } = await harness(t, { sermonReferences: [candidate.reference] });
      const proposal = await coordinator.propose(envelope(planV2()), options);
      assert.deepEqual(
        proposal.blockers.map(blocker => blocker.code),
        [candidate.blockerCode]
      );
      await assert.rejects(
        projectStore.read(proposal.projectId),
        error => error.code === 'PROJECT_NOT_FOUND'
      );
    });
  }
});

test('duplicate sermon owners sharing one pin repin atomically with both explicitly owned readings', async t => {
  const primaryA = sermonReference({ id: 'primary-a' });
  const primaryB = sermonReference({ id: 'primary-b' });
  const sermonState = {};
  let currentSermonRevision = SERMON_REVISION;
  let currentSermon = sermonDocument({
    references: [primaryA, primaryB]
  });
  const { coordinator, options } = await harness(t, {
    sermonState,
    sermonRevisionProvider(sermonId, revision) {
      assert.equal(sermonId, currentSermon.id);
      assert.equal(revision, currentSermonRevision);
      return { sermon: currentSermon, revision };
    }
  });
  const sourceEntries = planV2().entries;
  const sectionEntry = sourceEntries.find(entry => entry.kind === 'section');
  const readingEntry = sourceEntries.find(entry => entry.kind === 'scripture');
  const sermonEntry = sourceEntries.find(entry => entry.kind === 'sermon');
  const duplicatedPlan = ({
    revision = SERMON_REVISION,
    syncVersion = 4
  } = {}) => planV2({
    entries: [
      sectionEntry,
      {
        ...readingEntry,
        id: 'reading-a',
        title: 'First owned reading',
        sermonReading: {
          sermonEntryId: 'sermon-a',
          referenceId: primaryA.id
        }
      },
      {
        ...sermonEntry,
        id: 'sermon-a',
        title: 'First sermon occurrence',
        expectedRevision: revision,
        expectedSyncVersion: syncVersion
      },
      {
        ...readingEntry,
        id: 'reading-b',
        title: 'Second owned reading',
        sermonReading: {
          sermonEntryId: 'sermon-b',
          referenceId: primaryB.id
        }
      },
      {
        ...sermonEntry,
        id: 'sermon-b',
        title: 'Second sermon occurrence',
        expectedRevision: revision,
        expectedSyncVersion: syncVersion
      }
    ]
  });

  const first = await coordinator.importPlan(
    envelope(duplicatedPlan()),
    options
  );
  const sermonAId = managedItemId('sermon-a');
  const sermonBId = managedItemId('sermon-b');
  const readingAId = managedItemId('reading-a');
  const readingBId = managedItemId('reading-b');
  const previousResourceId =
    first.project.items[sermonAId].sermonResourceId;
  assert.equal(
    first.project.items[sermonBId].sermonResourceId,
    previousResourceId
  );
  assert.equal(
    first.project.items[readingAId].sermonReading.sermonResourceId,
    previousResourceId
  );
  assert.equal(
    first.project.items[readingBId].sermonReading.sermonResourceId,
    previousResourceId
  );

  currentSermonRevision = '7'.repeat(64);
  currentSermon = {
    ...currentSermon,
    titles: { en: 'One shared Community sermon revision' }
  };
  Object.assign(sermonState, {
    syncVersion: 5,
    localRevision: currentSermonRevision,
    remoteRevision: currentSermonRevision
  });
  const nextEnvelope = envelope(duplicatedPlan({
    revision: currentSermonRevision,
    syncVersion: 5
  }), { syncVersion: 5 });
  const reviewed = await coordinator.propose(nextEnvelope, options);
  assert.equal(reviewed.reconciliation.conflictCount, 0);

  const reconciled = await coordinator.replacePlanRevision(
    nextEnvelope,
    options,
    {
      expectedRevisionId: first.revisionId,
      decisions: []
    }
  );
  const nextResourceId =
    reconciled.project.items[sermonAId].sermonResourceId;
  assert.notEqual(nextResourceId, previousResourceId);
  for (const ownerId of [sermonAId, sermonBId]) {
    assert.equal(
      reconciled.project.items[ownerId].sermonResourceId,
      nextResourceId
    );
  }
  for (const readingId of [readingAId, readingBId]) {
    assert.equal(
      reconciled.project.items[readingId].sermonReading.sermonResourceId,
      nextResourceId
    );
  }
  assert.equal(reconciled.project.resources[previousResourceId], undefined);
});

test('draft, archived, and cancelled lifecycle states stay visible but cannot import or delete', async t => {
  const { coordinator, projectStore, options } = await harness(t);
  const ready = envelope();
  const imported = await coordinator.importPlan(ready, options);

  for (const [status, code] of [
    ['draft', 'PLAN_NOT_READY'],
    ['archived', 'PLAN_ARCHIVED'],
    ['cancelled', 'PLAN_CANCELLED']
  ]) {
    const proposal = await coordinator.propose(
      { ...ready, status, syncVersion: ready.syncVersion + 1 },
      options
    );
    assert.equal(proposal.status, 'blocked');
    assert.equal(proposal.remoteStatus, status);
    assert.equal(proposal.blockers[0].code, code);
    assert.equal(proposal.existingProject, true);
    await assert.rejects(
      coordinator.importPlan(
        { ...ready, status, syncVersion: ready.syncVersion + 1 },
        options
      ),
      expectImportCode('PLAN_IMPORT_BLOCKED')
    );
  }

  const current = await projectStore.read(imported.projectId);
  assert.equal(current.revisionId, imported.revisionId);
  assert.equal((await projectStore.listRevisions(imported.projectId)).total, 1);
});

test('changed, archived, and unresolved exact dependencies block without fuzzy substitution', async t => {
  const { coordinator, projectStore, options } = await harness(t, {
    songState: { syncVersion: 8 },
    publicationStatus: 'archived',
    bibleFailure: true
  });
  const remote = envelope();
  const proposal = await coordinator.propose(remote, options);

  assert.equal(proposal.status, 'blocked');
  assert.deepEqual(proposal.blockers.map(blocker => blocker.code), [
    'SERVICE_PLAN_SONG_PIN_STALE',
    'SCRIPTURE_TEXT_UNAVAILABLE',
    'LOCAL_SERMON_ARCHIVED'
  ]);
  await assert.rejects(
    coordinator.importPlan(remote, options),
    expectImportCode('PLAN_IMPORT_BLOCKED')
  );
  await assert.rejects(
    projectStore.read(proposal.projectId),
    error => error.code === 'PROJECT_NOT_FOUND'
  );
});

test('song checkpoint validation rejects malformed vectors before preserving record-state blocker precedence', async t => {
  const songOnly = plan({
    entries: [{
      id: 'song-grace',
      kind: 'song',
      title: 'Grace Alone',
      syncId: 'song-family-grace',
      expectedRevision: SONG_RECORD_REVISION,
      expectedSyncVersion: 7
    }]
  });
  const cleanDocuments = () => ({
    'grace-alone': {
      localRevision: ROOT_SONG_REVISION,
      remoteRevision: '1'.repeat(64)
    },
    'grace-alone-ru': {
      localRevision: RUSSIAN_SONG_REVISION,
      remoteRevision: '2'.repeat(64)
    }
  });
  const vectorCases = [{
    label: 'missing remote hash',
    alter(documents) {
      delete documents['grace-alone'].remoteRevision;
    }
  }, {
    label: 'null remote hash',
    alter(documents) {
      documents['grace-alone'].remoteRevision = null;
    }
  }, {
    label: 'uppercase remote hash',
    alter(documents) {
      documents['grace-alone'].remoteRevision = 'A'.repeat(64);
    }
  }, {
    label: 'malformed remote hash',
    alter(documents) {
      documents['grace-alone'].remoteRevision = 'not-a-document-hash';
    }
  }, {
    label: 'extra tracked document',
    alter(documents) {
      documents['unrelated-song'] = {
        localRevision: '3'.repeat(64),
        remoteRevision: '4'.repeat(64)
      };
    }
  }, {
    label: 'omitted tracked document',
    alter(documents) {
      delete documents['grace-alone-ru'];
    }
  }, {
    label: 'local revision drift',
    alter(documents) {
      documents['grace-alone'].localRevision = '5'.repeat(64);
    }
  }];

  for (const vectorCase of vectorCases) {
    const documents = cleanDocuments();
    vectorCase.alter(documents);
    const {
      coordinator,
      options,
      counts
    } = await harness(t, { songState: { documents } });
    const reviewed = await coordinator.review(envelope(songOnly), options);
    assert.deepEqual(
      reviewed.proposal.blockers.map(blocker => blocker.code),
      ['LOCAL_SONG_CHANGED'],
      vectorCase.label
    );
    assert.deepEqual(
      reviewed.preparationDependencies,
      [],
      `${vectorCase.label} must not become automatic preparation authority`
    );
    assert.equal(counts().snapshotCalls, 1, vectorCase.label);
  }

  const precedenceCases = [{
    label: 'exact conflict',
    songState: {
      conflict: { code: 'BOTH_CHANGED' }
    },
    blockerCode: 'LOCAL_SONG_CONFLICT'
  }, {
    label: 'exact archived record',
    songState: {
      archived: true
    },
    blockerCode: 'LOCAL_SONG_ARCHIVED'
  }, {
    label: 'stale plan pin before malformed vector',
    songState: {
      syncVersion: 8,
      remoteRevision: 'song:song-family-grace:8',
      documents: {
        'grace-alone': {
          localRevision: ROOT_SONG_REVISION,
          remoteRevision: null
        }
      }
    },
    blockerCode: 'SERVICE_PLAN_SONG_PIN_STALE'
  }];

  for (const precedenceCase of precedenceCases) {
    const {
      coordinator,
      options,
      counts
    } = await harness(t, { songState: precedenceCase.songState });
    const reviewed = await coordinator.review(envelope(songOnly), options);
    assert.deepEqual(
      reviewed.proposal.blockers.map(blocker => blocker.code),
      [precedenceCase.blockerCode],
      precedenceCase.label
    );
    assert.deepEqual(
      reviewed.preparationDependencies,
      [],
      `${precedenceCase.label} must not become automatic preparation authority`
    );
    assert.equal(
      counts().snapshotCalls,
      0,
      `${precedenceCase.label} must block before reading the local snapshot`
    );
  }
});

test('review classifies only exact missing song and sermon pins as preparable', async t => {
  const { coordinator, options } = await harness(t, {
    songState: { localFamilyId: null },
    sermonState: { localSermonId: null }
  });
  const reviewed = await coordinator.review(envelope(), options);

  assert.equal(reviewed.proposal.status, 'blocked');
  assert.deepEqual(
    reviewed.proposal.blockers.map(blocker => blocker.code),
    ['LOCAL_SONG_MISSING', 'LOCAL_SERMON_MISSING']
  );
  assert.deepEqual(
    reviewed.preparationDependencies.map(dependency => ({
      kind: dependency.kind,
      syncId: dependency.syncId,
      expectedSyncVersion: dependency.expectedSyncVersion,
      expectedRevision: dependency.expectedRevision,
      entryIds: dependency.entryIds,
      blockerCodes: dependency.blockerCodes
    })),
    [{
      kind: 'song',
      syncId: 'song-family-grace',
      expectedSyncVersion: 7,
      expectedRevision: SONG_RECORD_REVISION,
      entryIds: ['song-grace'],
      blockerCodes: ['LOCAL_SONG_MISSING']
    }, {
      kind: 'sermon',
      syncId: 'sermon-prayer',
      expectedSyncVersion: 4,
      expectedRevision: SERMON_REVISION,
      entryIds: ['sermon'],
      blockerCodes: ['LOCAL_SERMON_MISSING']
    }]
  );
  assert.ok(Object.isFrozen(reviewed.preparationDependencies));
});

test('an isolated clean song checkpoint behind its Ready plan pin is preparable', async t => {
  const { coordinator, options } = await harness(t, {
    songState: {
      syncVersion: 6,
      remoteRevision: 'song:song-family-grace:6'
    }
  });
  const songOnly = plan({
    entries: [{
      id: 'song-grace',
      kind: 'song',
      title: 'Grace Alone',
      syncId: 'song-family-grace',
      expectedRevision: SONG_RECORD_REVISION,
      expectedSyncVersion: 7
    }]
  });
  const reviewed = await coordinator.review(envelope(songOnly), options);

  assert.deepEqual(
    reviewed.proposal.blockers.map(blocker => blocker.code),
    ['LOCAL_SONG_REMOTE_BEHIND']
  );
  assert.deepEqual(
    reviewed.preparationDependencies.map(dependency => ({
      kind: dependency.kind,
      syncId: dependency.syncId,
      blockerCodes: dependency.blockerCodes
    })),
    [{
      kind: 'song',
      syncId: 'song-family-grace',
      blockerCodes: ['LOCAL_SONG_REMOTE_BEHIND']
    }]
  );
});

test('isolated ahead or divergent song pins require a refreshed plan and are not preparable', async t => {
  const songOnly = plan({
    entries: [{
      id: 'song-grace',
      kind: 'song',
      title: 'Grace Alone',
      syncId: 'song-family-grace',
      expectedRevision: SONG_RECORD_REVISION,
      expectedSyncVersion: 7
    }]
  });
  for (const [label, songState] of [
    ['ahead missing checkpoint', {
      localFamilyId: null,
      syncVersion: 8,
      remoteRevision: 'song:song-family-grace:8'
    }],
    ['same-version divergent revision', {
      syncVersion: 7,
      remoteRevision: 'song:song-family-grace:7-divergent'
    }],
    ['same-version divergent missing checkpoint', {
      localFamilyId: null,
      syncVersion: 7,
      remoteRevision: 'song:song-family-grace:7-divergent'
    }]
  ]) {
    await t.test(label, async t => {
      const { coordinator, options } = await harness(t, { songState });
      const reviewed = await coordinator.review(envelope(songOnly), options);
      assert.deepEqual(
        reviewed.proposal.blockers.map(blocker => blocker.code),
        ['SERVICE_PLAN_SONG_PIN_STALE']
      );
      assert.match(
        reviewed.proposal.blockers[0].message,
        /Refresh and review the plan in Community/
      );
      assert.deepEqual(reviewed.preparationDependencies, []);
    });
  }
});

test('an isolated clean sermon checkpoint behind its Ready plan pin is preparable', async t => {
  const behindRevision = 'a'.repeat(64);
  const { coordinator, options } = await harness(t, {
    sermonState: {
      syncVersion: 3,
      localRevision: behindRevision,
      remoteRevision: behindRevision
    }
  });
  const sermonOnly = plan({
    entries: [{
      id: 'sermon',
      kind: 'sermon',
      title: 'The Prayer That Transforms the Church',
      syncId: 'sermon-prayer',
      expectedRevision: SERMON_REVISION,
      expectedSyncVersion: 4
    }]
  });
  const reviewed = await coordinator.review(envelope(sermonOnly), options);

  assert.deepEqual(
    reviewed.proposal.blockers.map(blocker => blocker.code),
    ['LOCAL_SERMON_REMOTE_BEHIND']
  );
  assert.deepEqual(
    reviewed.preparationDependencies.map(dependency => ({
      kind: dependency.kind,
      syncId: dependency.syncId,
      blockerCodes: dependency.blockerCodes
    })),
    [{
      kind: 'sermon',
      syncId: 'sermon-prayer',
      blockerCodes: ['LOCAL_SERMON_REMOTE_BEHIND']
    }]
  );
});

test('isolated ahead or divergent sermon pins require a refreshed plan and are not preparable', async t => {
  const sermonOnly = plan({
    entries: [{
      id: 'sermon',
      kind: 'sermon',
      title: 'The Prayer That Transforms the Church',
      syncId: 'sermon-prayer',
      expectedRevision: SERMON_REVISION,
      expectedSyncVersion: 4
    }]
  });
  for (const [label, sermonState] of [
    ['ahead missing checkpoint', {
      localSermonId: null,
      syncVersion: 5,
      remoteRevision: 'e'.repeat(64)
    }],
    ['same-version divergent revision', {
      syncVersion: 4,
      remoteRevision: 'e'.repeat(64)
    }],
    ['same-version divergent missing checkpoint', {
      localSermonId: null,
      syncVersion: 4,
      remoteRevision: 'e'.repeat(64)
    }]
  ]) {
    await t.test(label, async t => {
      const { coordinator, options } = await harness(t, { sermonState });
      const reviewed = await coordinator.review(envelope(sermonOnly), options);
      assert.deepEqual(
        reviewed.proposal.blockers.map(blocker => blocker.code),
        ['SERVICE_PLAN_SERMON_PIN_STALE']
      );
      assert.match(
        reviewed.proposal.blockers[0].message,
        /Refresh and review the plan in Community/
      );
      assert.deepEqual(reviewed.preparationDependencies, []);
    });
  }
});

test('mixed human-only blockers suppress plan-item preparation authority', async t => {
  const { coordinator, options } = await harness(t, {
    songState: { localFamilyId: null },
    sermonState: { localSermonId: null },
    bibleFailure: true
  });
  const reviewed = await coordinator.review(envelope(), options);

  assert.deepEqual(
    reviewed.proposal.blockers.map(blocker => blocker.code),
    [
      'LOCAL_SONG_MISSING',
      'SCRIPTURE_TEXT_UNAVAILABLE',
      'LOCAL_SERMON_MISSING'
    ]
  );
  assert.deepEqual(reviewed.preparationDependencies, []);
});

test('repeated exact dependency pins deduplicate while conflicting pins fail closed', async t => {
  const { coordinator, options } = await harness(t, {
    songState: { localFamilyId: null }
  });
  const repeatedEntries = [{
    id: 'opening',
    kind: 'section',
    title: 'Opening'
  }, {
    id: 'song-grace-one',
    kind: 'song',
    title: 'Grace Alone',
    syncId: 'song-family-grace',
    expectedRevision: SONG_RECORD_REVISION,
    expectedSyncVersion: 7
  }, {
    id: 'song-grace-two',
    kind: 'song',
    title: 'Grace Alone reprise',
    syncId: 'song-family-grace',
    expectedRevision: SONG_RECORD_REVISION,
    expectedSyncVersion: 7
  }];
  const repeated = await coordinator.review(
    envelope(plan({ entries: repeatedEntries })),
    options
  );
  assert.equal(repeated.preparationDependencies.length, 1);
  assert.deepEqual(
    repeated.preparationDependencies[0].entryIds,
    ['song-grace-one', 'song-grace-two']
  );

  const conflictingEntries = repeatedEntries.map((entry, index) =>
    index === 2
      ? {
          ...entry,
          expectedRevision: 'song:song-family-grace:8',
          expectedSyncVersion: 8
        }
      : entry);
  const conflicting = await coordinator.review(
    envelope(plan({ entries: conflictingEntries })),
    options
  );
  assert.deepEqual(conflicting.preparationDependencies, []);
});

test('a different ready revision returns a bounded diff and never mutates the imported project', async t => {
  const { coordinator, projectStore, options } = await harness(t);
  const first = await coordinator.importPlan(envelope(), options);
  const expanded = plan({
    title: 'Updated Sunday Service',
    teamNotes: 'Doors open at 09:30.',
    entries: Array.from({ length: 500 }, (_, index) => ({
      id: index === 0 ? 'opening' : `section-${index}`,
      kind: 'section',
      title: index === 0 ? 'Opening Updated' : `Section ${index}`
    }))
  });
  const next = envelope(expanded, { syncVersion: 4 });

  const proposal = await coordinator.propose(next, options);
  assert.equal(proposal.status, 'newer-revision');
  assert.equal(proposal.diff.fromRevision, envelope().revision);
  assert.equal(proposal.diff.toRevision, next.revision);
  assert.equal(proposal.diff.metadataChanges.titleChanged, true);
  assert.equal(proposal.diff.metadataChanges.teamNotesChanged, true);
  assert.equal(proposal.diff.changes.length, MAX_COMMUNITY_PLAN_DIFF_ITEMS);
  assert.equal(proposal.diff.truncated, true);
  await assert.rejects(
    coordinator.importPlan(next, options),
    expectImportCode('PLAN_REVISION_REVIEW_REQUIRED')
  );

  const current = await projectStore.read(first.projectId);
  assert.equal(current.revisionId, first.revisionId);
  assert.equal((await projectStore.listRevisions(first.projectId)).total, 1);
});

test('an explicitly reviewed newer Ready revision replaces by local CAS and preserves immutable history', async t => {
  const { coordinator, projectStore, options } = await harness(t);
  const firstEnvelope = envelope();
  const first = await coordinator.importPlan(firstEnvelope, options);
  const nextEnvelope = envelope(plan({
    title: 'Updated Sunday Service',
    teamNotes: 'Updated team notes.',
    entries: [{
      id: 'opening',
      kind: 'section',
      title: 'Updated opening'
    }, {
      id: 'reading',
      kind: 'scripture',
      title: 'Ephesians 3:14–15',
      range: {
        schemaVersion: 1,
        bookId: 'Eph',
        start: { chapter: 3, verse: 14 },
        end: { chapter: 3, verse: 15 }
      },
      translationId: 'BSB'
    }, {
      id: 'sermon',
      kind: 'sermon',
      title: 'The Prayer That Transforms the Church',
      syncId: 'sermon-prayer',
      expectedRevision: SERMON_REVISION,
      expectedSyncVersion: 4
    }]
  }), { syncVersion: 4 });

  const reviewed = await coordinator.propose(nextEnvelope, options);
  assert.equal(reviewed.status, 'newer-revision');
  assert.equal(reviewed.revisionId, first.revisionId);

  const replaced = await coordinator.replacePlanRevision(
    nextEnvelope,
    options,
    { expectedRevisionId: reviewed.revisionId }
  );
  assert.equal(replaced.status, 'reconciled');
  assert.equal(replaced.projectId, first.projectId);
  assert.equal(replaced.previousRevisionId, first.revisionId);
  assert.notEqual(replaced.revisionId, first.revisionId);
  assert.equal(replaced.project.planning.status, 'planning');
  assert.equal(
    replaced.project.planning.source.planRevision,
    nextEnvelope.revision
  );
  assert.equal(replaced.project.title, 'Updated Sunday Service');

  const history = await projectStore.listRevisions(first.projectId);
  assert.equal(history.total, 2);
  assert.equal(history.currentRevisionId, replaced.revisionId);
  const retained = await projectStore.read(first.projectId, {
    revisionId: first.revisionId
  });
  assert.equal(retained.project.title, first.project.title);
  assert.equal(
    retained.project.planning.source.planRevision,
    firstEnvelope.revision
  );

  await assert.rejects(
    coordinator.replacePlanRevision(nextEnvelope, options, {
      expectedRevisionId: first.revisionId
    }),
    expectImportCode('PLAN_REPLACEMENT_STALE')
  );
  assert.equal(
    (await projectStore.listRevisions(first.projectId)).total,
    2,
    'replaying the replacement cannot create another revision'
  );
});

test('three-way Community reconciliation preserves local-only production work while applying remote changes', async t => {
  const { coordinator, projectStore, options } = await harness(t);
  const first = await coordinator.importPlan(envelope(), options);
  const openingId = first.project.rootItemIds[0];
  const locallyEdited = addGroupItem(first.project, {
    id: 'local-volunteer-cues',
    title: 'Volunteer-only cues',
    groupKind: 'custom',
    parentId: openingId,
    operatorNotes: 'Prepared on the show computer.',
    now: NOW
  });
  const localSave = await projectStore.save(locallyEdited, {
    expectedRevisionId: first.revisionId,
    reason: 'local-production-work'
  });
  const nextEnvelope = envelope(plan({
    teamNotes: 'Community notes changed.',
    entries: [
      ...plan().entries,
      {
        id: 'closing',
        kind: 'section',
        title: 'Closing'
      }
    ]
  }), { syncVersion: 4 });

  const reviewed = await coordinator.propose(nextEnvelope, options);
  assert.equal(reviewed.status, 'newer-revision');
  assert.equal(reviewed.reconciliation.mode, 'three-way');
  assert.equal(reviewed.reconciliation.applicable, true);
  assert.equal(reviewed.reconciliation.conflictCount, 0);
  assert.ok(reviewed.reconciliation.preservedLocalItemCount >= 1);
  assert.ok(reviewed.reconciliation.appliedCommunityItemCount >= 1);

  const reconciled = await coordinator.replacePlanRevision(
    nextEnvelope,
    options,
    {
      expectedRevisionId: localSave.revisionId,
      decisions: []
    }
  );
  assert.equal(reconciled.status, 'reconciled');
  assert.equal(
    reconciled.project.items['local-volunteer-cues'].operatorNotes,
    'Prepared on the show computer.'
  );
  assert.equal(reconciled.project.planning.teamNotes, 'Community notes changed.');
  assert.ok(
    Object.values(reconciled.project.items).some(item =>
      item.title === 'Closing')
  );
  assert.equal(reconciled.project.planning.schemaVersion, 3);
  assert.equal(
    reconciled.project.planning.reconciliationBaseline.planRevision,
    nextEnvelope.revision
  );
});

test('an untouched song pin update uses the new generated arrangement without an old/new hybrid', async t => {
  const songState = {};
  const mutable = mutableSongCatalog();
  const { coordinator, options } = await harness(t, {
    songState,
    songSnapshotProvider: () => mutable.snapshotProvider(),
    songRevisionProvider: (songId, revision) =>
      mutable.revisionProvider(songId, revision)
  });
  const first = await coordinator.importPlan(envelope(), options);
  const songItem = Object.values(first.project.items).find(item =>
    item.kind === 'song');
  const oldSectionIds = songItem.arrangement.map(entry => entry.sectionId);

  const nextRootSong = songDocumentWithSections(['1', 'bridge']);
  const nextRussianSong = songDocumentWithSections(['1', 'bridge'], {
    id: 'grace-alone-ru',
    title: 'Только благодать',
    language: 'ru',
    translationOf: 'grace-alone'
  });
  const nextRootRevision = '1'.repeat(64);
  const nextRussianRevision = '5'.repeat(64);
  const nextFamilyRevision = '2'.repeat(64);
  const nextRecordRevision = 'song:song-family-grace:8';
  mutable.catalog.rootSong = nextRootSong;
  mutable.catalog.rootRevision = nextRootRevision;
  mutable.catalog.russianSong = nextRussianSong;
  mutable.catalog.russianRevision = nextRussianRevision;
  mutable.catalog.familyRevision = nextFamilyRevision;
  Object.assign(songState, {
    syncVersion: 8,
    remoteRevision: nextRecordRevision,
    documents: {
      'grace-alone': {
        localRevision: nextRootRevision,
        remoteRevision: nextRootRevision
      },
      'grace-alone-ru': {
        localRevision: nextRussianRevision,
        remoteRevision: nextRussianRevision
      }
    }
  });
  const nextEnvelope = envelope(plan({
    entries: plan().entries.map(entry =>
      entry.id === 'song-grace'
        ? {
            ...entry,
            expectedRevision: nextRecordRevision,
            expectedSyncVersion: 8
          }
        : entry)
  }), { syncVersion: 4 });
  const reviewed = await coordinator.propose(nextEnvelope, options);
  assert.equal(reviewed.reconciliation.conflictCount, 0);

  const reconciled = await coordinator.replacePlanRevision(
    nextEnvelope,
    options,
    {
      expectedRevisionId: first.revisionId,
      decisions: []
    }
  );
  const nextSongItem = reconciled.project.items[songItem.id];
  assert.deepEqual(
    nextSongItem.arrangement.map(entry => entry.sectionId),
    nextRootSong.sections.map(section => section.id)
  );
  assert.notDeepEqual(
    nextSongItem.arrangement.map(entry => entry.sectionId),
    oldSectionIds
  );
});

test('a song pin change with a local arrangement is one whole-song choice while a local title merges independently', async t => {
  for (const choice of ['keep-local', 'use-community']) {
    await t.test(choice, async subtest => {
      const songState = {};
      const mutable = mutableSongCatalog();
      const { coordinator, projectStore, options } = await harness(subtest, {
        songState,
        songSnapshotProvider: () => mutable.snapshotProvider(),
        songRevisionProvider: (songId, revision) =>
          mutable.revisionProvider(songId, revision)
      });
      const first = await coordinator.importPlan(envelope(), options);
      const songItem = Object.values(first.project.items).find(item =>
        item.kind === 'song');
      const customArrangement = [...songItem.arrangement].reverse();
      let local = updateSongArrangement(first.project, {
        itemId: songItem.id,
        arrangement: customArrangement,
        now: NOW
      });
      local = updatePresentationItem(local, {
        itemId: songItem.id,
        title: 'Locally preferred song title',
        now: NOW
      });
      const localSave = await projectStore.save(local, {
        expectedRevisionId: first.revisionId,
        reason: `local-song-arrangement-${choice}`
      });

      const nextRootSong = songDocumentWithSections(['1', 'bridge']);
      const nextRussianSong = songDocumentWithSections(['1', 'bridge'], {
        id: 'grace-alone-ru',
        title: 'Только благодать',
        language: 'ru',
        translationOf: 'grace-alone'
      });
      const nextRootRevision = '3'.repeat(64);
      const nextRussianRevision = '6'.repeat(64);
      const nextRecordRevision = 'song:song-family-grace:8';
      mutable.catalog.rootSong = nextRootSong;
      mutable.catalog.rootRevision = nextRootRevision;
      mutable.catalog.russianSong = nextRussianSong;
      mutable.catalog.russianRevision = nextRussianRevision;
      mutable.catalog.familyRevision = '4'.repeat(64);
      Object.assign(songState, {
        syncVersion: 8,
        remoteRevision: nextRecordRevision,
        documents: {
          'grace-alone': {
            localRevision: nextRootRevision,
            remoteRevision: nextRootRevision
          },
          'grace-alone-ru': {
            localRevision: nextRussianRevision,
            remoteRevision: nextRussianRevision
          }
        }
      });
      const nextEnvelope = envelope(plan({
        entries: plan().entries.map(entry =>
          entry.id === 'song-grace'
            ? {
                ...entry,
                expectedRevision: nextRecordRevision,
                expectedSyncVersion: 8
              }
            : entry)
      }), { syncVersion: 4 });
      const reviewed = await coordinator.propose(nextEnvelope, options);
      const pinConflict = reviewed.reconciliation.conflicts.find(conflict =>
        conflict.kind
          === 'COMMUNITY_SONG_PIN_CHANGED_WITH_LOCAL_ARRANGEMENT');
      assert.ok(pinConflict);
      assert.equal(
        reviewed.reconciliation.conflicts.some(conflict =>
          conflict.kind === 'LOCAL_AND_COMMUNITY_TITLE_CHANGED'),
        false
      );

      const reconciled = await coordinator.replacePlanRevision(
        nextEnvelope,
        options,
        {
          expectedRevisionId: localSave.revisionId,
          decisions: reviewed.reconciliation.conflicts.map(conflict => ({
            conflictId: conflict.conflictId,
            choice: conflict.conflictId === pinConflict.conflictId
              ? choice
              : 'keep-local'
          }))
        }
      );
      const result = reconciled.project.items[songItem.id];
      assert.equal(result.title, 'Locally preferred song title');
      if (choice === 'keep-local') {
        assert.deepEqual(result.arrangement, customArrangement);
        assert.deepEqual(result.variants, songItem.variants);
      } else {
        assert.deepEqual(
          result.arrangement.map(entry => entry.sectionId),
          nextRootSong.sections.map(section => section.id)
        );
        assert.notDeepEqual(result.variants, songItem.variants);
      }
    });
  }
});

test('Scripture resolver drift is ignored when its spec is unchanged and the carried baseline stays stable', async t => {
  const { coordinator, options } = await harness(t, {
    biblePassageProvider({ call }) {
      const passage = biblePassage();
      if (call > 1) {
        passage.verses[0].text = 'Resolver returned revised wording.';
      }
      return passage;
    }
  });
  const first = await coordinator.importPlan(envelope(), options);
  const reading = Object.values(first.project.items).find(item =>
    item.kind === 'bible');
  const originalPassages = reading.passagesByChannel;
  const originalBaselineEntry =
    first.project.planning.reconciliationBaseline.entries.find(entry =>
      entry.itemId === reading.id);

  const envelopeB = envelope(plan({
    teamNotes: 'Unrelated Community note B'
  }), { syncVersion: 4 });
  const reviewB = await coordinator.propose(envelopeB, options);
  assert.equal(reviewB.reconciliation.conflictCount, 0);
  const savedB = await coordinator.replacePlanRevision(
    envelopeB,
    options,
    {
      expectedRevisionId: first.revisionId,
      decisions: []
    }
  );
  assert.deepEqual(
    savedB.project.items[reading.id].passagesByChannel,
    originalPassages
  );
  const baselineB =
    savedB.project.planning.reconciliationBaseline;
  const baselineEntryB = baselineB.entries.find(entry =>
    entry.itemId === reading.id);
  assert.equal(
    baselineEntryB.dependentStateSha256,
    originalBaselineEntry.dependentStateSha256
  );
  assert.equal(
    baselineB.projectionSha256,
    reviewB.reconciliation.candidateProjectionSha256
  );

  const envelopeC = envelope(plan({
    teamNotes: 'Unrelated Community note C'
  }), { syncVersion: 5 });
  const reviewC = await coordinator.propose(envelopeC, options);
  assert.equal(reviewC.reconciliation.conflictCount, 0);
  const savedC = await coordinator.replacePlanRevision(
    envelopeC,
    options,
    {
      expectedRevisionId: savedB.revisionId,
      decisions: []
    }
  );
  assert.deepEqual(
    savedC.project.items[reading.id].passagesByChannel,
    originalPassages
  );
});

test('a Community sermon-reading relationship change preserves a local Scripture spec and snapshot', async t => {
  const primaryReference = sermonReference({
    startVerse: 14,
    endVerse: 15
  });
  const alternateReference = sermonReference({
    id: 'primary-eph-3-alt',
    startVerse: 14,
    endVerse: 15
  });
  const { coordinator, projectStore, options } = await harness(t, {
    sermonReferences: [primaryReference, alternateReference]
  });
  const firstEnvelope = envelope(planV2());
  const first = await coordinator.importPlan(firstEnvelope, options);
  const reading = Object.values(first.project.items).find(item =>
    item.kind === 'bible');
  const rawLocal = JSON.parse(
    require('../src/services/project').serializeServiceProject(first.project)
  );
  rawLocal.items[reading.id].range.end.verse = 14;
  rawLocal.items[reading.id].passagesByChannel.primary.verseEnd = 14;
  rawLocal.items[reading.id].passagesByChannel.primary.verses =
    rawLocal.items[reading.id].passagesByChannel.primary.verses.slice(0, 1);
  rawLocal.items[reading.id].passagesByChannel.primary.reference =
    'Ephesians 3:14';
  delete rawLocal.items[reading.id].passagesByChannel.primary.contentSha256;
  rawLocal.items[reading.id].passagesByChannel.secondary.verseEnd = 14;
  rawLocal.items[reading.id].passagesByChannel.secondary.verses =
    rawLocal.items[reading.id].passagesByChannel.secondary.verses.slice(0, 1);
  rawLocal.items[reading.id].passagesByChannel.secondary.reference =
    'Ephesians 3:14';
  delete rawLocal.items[reading.id].passagesByChannel.secondary.contentSha256;
  const local = normalizeServiceProject(rawLocal);
  const localSave = await projectStore.save(local, {
    expectedRevisionId: first.revisionId,
    reason: 'local-scripture-range'
  });
  const nextEntries = planV2().entries.map(entry => {
    if (entry.id !== 'reading') return entry;
    return {
      ...entry,
      sermonReading: {
        ...entry.sermonReading,
        referenceId: 'primary-eph-3-alt'
      }
    };
  });
  const nextEnvelope = envelope(planV2({
    entries: nextEntries
  }), { syncVersion: 4 });
  const reviewed = await coordinator.propose(nextEnvelope, options);
  assert.equal(reviewed.reconciliation.conflictCount, 0);

  const reconciled = await coordinator.replacePlanRevision(
    nextEnvelope,
    options,
    {
      expectedRevisionId: localSave.revisionId,
      decisions: []
    }
  );
  assert.equal(
    reconciled.project.items[reading.id].range.end.verse,
    14
  );
  assert.equal(
    reconciled.project.items[reading.id]
      .passagesByChannel.primary.verses.length,
    1
  );
  assert.equal(
    reconciled.project.items[reading.id].sermonReading.referenceId,
    'primary-eph-3-alt'
  );
});

test('a v2 sermon pin update atomically repins its reading while preserving the passage snapshot', async t => {
  const primaryReference = sermonReference({
    startVerse: 14,
    endVerse: 15
  });
  const sermonState = {};
  let currentSermonRevision = SERMON_REVISION;
  let currentSermon = sermonDocument({
    references: [primaryReference]
  });
  const { coordinator, options } = await harness(t, {
    sermonState,
    sermonRevisionProvider(sermonId, revision) {
      assert.equal(sermonId, currentSermon.id);
      assert.equal(revision, currentSermonRevision);
      return { sermon: currentSermon, revision };
    },
    biblePassageProvider({ call }) {
      const passage = biblePassage();
      if (call > 1) {
        passage.verses[0].text = 'Resolver drift must not replace the reading.';
      }
      return passage;
    }
  });
  const first = await coordinator.importPlan(
    envelope(planV2()),
    options
  );
  const sermonGroup = Object.values(first.project.items).find(item =>
    item.kind === 'group' && item.groupKind === 'sermon');
  const reading = Object.values(first.project.items).find(item =>
    item.kind === 'bible');
  const previousResourceId = sermonGroup.sermonResourceId;
  const originalPassages = reading.passagesByChannel;

  currentSermonRevision = '7'.repeat(64);
  currentSermon = {
    ...currentSermon,
    titles: { en: 'The Prayer — revised' }
  };
  Object.assign(sermonState, {
    syncVersion: 5,
    localRevision: currentSermonRevision,
    remoteRevision: currentSermonRevision
  });
  const nextEnvelope = envelope(planV2({
    entries: planV2().entries.map(entry =>
      entry.id === 'sermon'
        ? {
            ...entry,
            expectedRevision: currentSermonRevision,
            expectedSyncVersion: 5
          }
        : entry)
  }), { syncVersion: 5 });
  const reviewed = await coordinator.propose(nextEnvelope, options);
  assert.equal(reviewed.reconciliation.conflictCount, 0);

  const reconciled = await coordinator.replacePlanRevision(
    nextEnvelope,
    options,
    {
      expectedRevisionId: first.revisionId,
      decisions: []
    }
  );
  const nextGroup = reconciled.project.items[sermonGroup.id];
  const nextReading = reconciled.project.items[reading.id];
  assert.notEqual(nextGroup.sermonResourceId, previousResourceId);
  assert.equal(
    nextReading.sermonReading.sermonResourceId,
    nextGroup.sermonResourceId
  );
  assert.deepEqual(nextReading.passagesByChannel, originalPassages);
  assert.equal(reconciled.project.resources[previousResourceId], undefined);
});

test('a sermon pin update with local descendants is one atomic explicit choice', async t => {
  for (const choice of ['keep-local', 'use-community']) {
    await t.test(choice, async subtest => {
      const primaryReference = sermonReference({
        startVerse: 14,
        endVerse: 15
      });
      const sermonState = {};
      let currentSermonRevision = SERMON_REVISION;
      let currentSermon = sermonDocument({
        references: [primaryReference]
      });
      const { coordinator, projectStore, options } = await harness(subtest, {
        sermonState,
        sermonRevisionProvider(sermonId, revision) {
          assert.equal(sermonId, currentSermon.id);
          assert.equal(revision, currentSermonRevision);
          return { sermon: currentSermon, revision };
        }
      });
      const first = await coordinator.importPlan(
        envelope(planV2()),
        options
      );
      const sermonGroup = Object.values(first.project.items).find(item =>
        item.kind === 'group' && item.groupKind === 'sermon');
      const reading = Object.values(first.project.items).find(item =>
        item.kind === 'bible');
      const previousResourceId = sermonGroup.sermonResourceId;
      const withLocalCue = addGroupItem(first.project, {
        id: 'local-sermon-cue-group',
        title: 'Local sermon cue group',
        groupKind: 'custom',
        parentId: sermonGroup.id,
        now: NOW
      });
      const localSave = await projectStore.save(withLocalCue, {
        expectedRevisionId: first.revisionId,
        reason: `local-sermon-cue-${choice}`
      });

      currentSermonRevision = '8'.repeat(64);
      currentSermon = {
        ...currentSermon,
        titles: { en: 'The Prayer — Community revision' }
      };
      Object.assign(sermonState, {
        syncVersion: 5,
        localRevision: currentSermonRevision,
        remoteRevision: currentSermonRevision
      });
      const nextEnvelope = envelope(planV2({
        entries: planV2().entries.map(entry =>
          entry.id === 'sermon'
            ? {
                ...entry,
                expectedRevision: currentSermonRevision,
                expectedSyncVersion: 5
              }
            : entry)
      }), { syncVersion: 5 });
      const reviewed = await coordinator.propose(nextEnvelope, options);
      const pinConflict = reviewed.reconciliation.conflicts.find(conflict =>
        conflict.kind
          === 'COMMUNITY_SERMON_PIN_CHANGED_WITH_LOCAL_WORK');
      assert.ok(pinConflict);

      const reconciled = await coordinator.replacePlanRevision(
        nextEnvelope,
        options,
        {
          expectedRevisionId: localSave.revisionId,
          decisions: reviewed.reconciliation.conflicts.map(conflict => ({
            conflictId: conflict.conflictId,
            choice: conflict.conflictId === pinConflict.conflictId
              ? choice
              : 'keep-local'
          }))
        }
      );
      const nextGroup = reconciled.project.items[sermonGroup.id];
      const nextReading = reconciled.project.items[reading.id];
      assert.ok(reconciled.project.items['local-sermon-cue-group']);
      if (choice === 'keep-local') {
        assert.equal(nextGroup.sermonResourceId, previousResourceId);
        assert.equal(
          nextReading.sermonReading.sermonResourceId,
          previousResourceId
        );
      } else {
        assert.notEqual(nextGroup.sermonResourceId, previousResourceId);
        assert.equal(
          nextReading.sermonReading.sermonResourceId,
          nextGroup.sermonResourceId
        );
      }
    });
  }
});

test('reconciliation prunes removed Community records but retains reachable local-only resources', async t => {
  const { coordinator, projectStore, options } = await harness(t);
  const first = await coordinator.importPlan(envelope(), options);
  const openingId = first.project.rootItemIds[0];
  const managedSermonGroup = Object.values(first.project.items).find(item =>
    item.kind === 'group' && item.groupKind === 'sermon');
  const removedResourceId = managedSermonGroup.sermonResourceId;
  const localDocument = {
    ...sermonDocument(),
    id: 'local-only-sermon',
    titles: { en: 'Local-only volunteer material' }
  };
  const embedded = addSermonResource(first.project, localDocument, {
    provider: 'local-sermon-library',
    itemId: localDocument.id
  });
  const withLocalItem = addGroupItem(embedded.project, {
    id: 'local-only-sermon-cues',
    title: 'Local-only sermon cues',
    groupKind: 'sermon',
    sermonResourceId: embedded.resourceId,
    parentId: openingId,
    now: NOW
  });
  const localSave = await projectStore.save(withLocalItem, {
    expectedRevisionId: first.revisionId,
    reason: 'local-only-sermon-resource'
  });
  const nextEnvelope = envelope(plan({
    entries: plan().entries.filter(entry => entry.id !== 'sermon')
  }), { syncVersion: 4 });
  const reviewed = await coordinator.propose(nextEnvelope, options);
  assert.equal(reviewed.reconciliation.conflictCount, 0);

  const reconciled = await coordinator.replacePlanRevision(
    nextEnvelope,
    options,
    {
      expectedRevisionId: localSave.revisionId,
      decisions: []
    }
  );
  assert.equal(reconciled.project.resources[removedResourceId], undefined);
  assert.ok(reconciled.project.resources[embedded.resourceId]);
  assert.equal(
    reconciled.project.items['local-only-sermon-cues'].sermonResourceId,
    embedded.resourceId
  );
});

test('accepting a deleted Community parent prunes its unreachable local-only resource', async t => {
  const initialPlan = plan({
    entries: [{
      id: 'community-parent',
      kind: 'section',
      title: 'Community parent'
    }, {
      id: 'surviving-parent',
      kind: 'section',
      title: 'Surviving parent'
    }]
  });
  const { coordinator, projectStore, options } = await harness(t);
  const first = await coordinator.importPlan(
    envelope(initialPlan),
    options
  );
  const deletedParentId = managedItemId('community-parent');
  const survivingParentId = managedItemId('surviving-parent');
  const removedDocument = {
    ...sermonDocument(),
    id: 'local-private-removed-sermon',
    titles: { en: 'Private removed sermon' }
  };
  const survivingDocument = {
    ...sermonDocument(),
    id: 'local-private-surviving-sermon',
    titles: { en: 'Private surviving sermon' }
  };
  const removed = addSermonResource(first.project, removedDocument, {
    provider: 'local-sermon-library',
    itemId: removedDocument.id
  });
  let local = addGroupItem(removed.project, {
    id: 'local-resource-descendant',
    title: 'Local resource descendant',
    groupKind: 'sermon',
    sermonResourceId: removed.resourceId,
    parentId: deletedParentId,
    now: NOW
  });
  const surviving = addSermonResource(local, survivingDocument, {
    provider: 'local-sermon-library',
    itemId: survivingDocument.id
  });
  local = addGroupItem(surviving.project, {
    id: 'unrelated-local-resource-owner',
    title: 'Unrelated local resource owner',
    groupKind: 'sermon',
    sermonResourceId: surviving.resourceId,
    parentId: survivingParentId,
    now: NOW
  });
  const localSave = await projectStore.save(local, {
    expectedRevisionId: first.revisionId,
    reason: 'private-local-record-under-deleted-community-parent'
  });
  const nextEnvelope = envelope(plan({
    entries: [{
      id: 'surviving-parent',
      kind: 'section',
      title: 'Surviving parent'
    }]
  }), { syncVersion: 4 });
  const reviewed = await coordinator.propose(nextEnvelope, options);
  const parentConflict = reviewed.reconciliation.conflicts.find(conflict =>
    conflict.itemId === deletedParentId
    && conflict.kind === 'COMMUNITY_PARENT_DELETED_WITH_LOCAL_CHILDREN');
  assert.ok(parentConflict);

  const reconciled = await coordinator.replacePlanRevision(
    nextEnvelope,
    options,
    {
      expectedRevisionId: localSave.revisionId,
      decisions: reviewed.reconciliation.conflicts.map(conflict => ({
        conflictId: conflict.conflictId,
        choice: conflict.conflictId === parentConflict.conflictId
          ? 'use-community'
          : 'keep-local'
      }))
    }
  );
  assert.equal(reconciled.project.items[deletedParentId], undefined);
  assert.equal(
    reconciled.project.items['local-resource-descendant'],
    undefined
  );
  assert.equal(reconciled.project.resources[removed.resourceId], undefined);
  assert.ok(
    reconciled.project.items['unrelated-local-resource-owner']
  );
  assert.ok(reconciled.project.resources[surviving.resourceId]);
});

test('divergent local and Community edits require one explicit bound choice', async t => {
  const { coordinator, projectStore, options } = await harness(t);
  const first = await coordinator.importPlan(envelope(), options);
  const openingId = first.project.rootItemIds[0];
  const local = updateGroupItem(first.project, {
    itemId: openingId,
    title: 'Local opening title',
    now: NOW
  });
  const localSave = await projectStore.save(local, {
    expectedRevisionId: first.revisionId,
    reason: 'local-opening-edit'
  });
  const nextEnvelope = envelope(plan({
    entries: plan().entries.map(entry =>
      entry.id === 'opening'
        ? { ...entry, title: 'Community opening title' }
        : entry)
  }), { syncVersion: 4 });
  const reviewed = await coordinator.propose(nextEnvelope, options);
  assert.equal(reviewed.reconciliation.conflictCount, 1);
  const [conflict] = reviewed.reconciliation.conflicts;
  assert.equal(conflict.kind, 'LOCAL_AND_COMMUNITY_TITLE_CHANGED');

  await assert.rejects(
    coordinator.replacePlanRevision(nextEnvelope, options, {
      expectedRevisionId: localSave.revisionId,
      decisions: []
    }),
    expectImportCode('COMMUNITY_PLAN_RECONCILIATION_DECISIONS_REQUIRED')
  );
  assert.equal(
    (await projectStore.read(first.projectId)).revisionId,
    localSave.revisionId
  );

  await assert.rejects(
    coordinator.replacePlanRevision(nextEnvelope, options, {
      expectedRevisionId: localSave.revisionId,
      decisions: [{
        conflictId: conflict.conflictId,
        choice: 'keep-local'
      }],
      expectedReconciliation: {
        mode: reviewed.reconciliation.mode,
        baselineProjectionSha256:
          reviewed.reconciliation.baselineProjectionSha256,
        candidateProjectionSha256: '0'.repeat(64),
        mergeResultSha256: reviewed.reconciliation.mergeResultSha256
      }
    }),
    expectImportCode('PLAN_RECONCILIATION_STALE')
  );

  const reconciled = await coordinator.replacePlanRevision(
    nextEnvelope,
    options,
    {
      expectedRevisionId: localSave.revisionId,
      decisions: [{
        conflictId: conflict.conflictId,
        choice: 'keep-local'
      }]
    }
  );
  assert.equal(
    reconciled.project.items[openingId].title,
    'Local opening title'
  );
  assert.equal(
    reconciled.project.planning.source.planRevision,
    nextEnvelope.revision
  );
});

test('a retained local override remains local across the next Community refresh', async t => {
  const { coordinator, projectStore, options } = await harness(t);
  const first = await coordinator.importPlan(envelope(), options);
  const openingId = first.project.rootItemIds[0];
  const local = updateGroupItem(first.project, {
    itemId: openingId,
    title: 'Locally preferred opening',
    now: NOW
  });
  const localSave = await projectStore.save(local, {
    expectedRevisionId: first.revisionId,
    reason: 'local-opening-override'
  });
  const planB = plan({
    entries: plan().entries.map(entry =>
      entry.id === 'opening'
        ? { ...entry, title: 'Community opening B' }
        : entry)
  });
  const envelopeB = envelope(planB, { syncVersion: 4 });
  const reviewB = await coordinator.propose(envelopeB, options);
  const conflictB = reviewB.reconciliation.conflicts[0];
  const savedB = await coordinator.replacePlanRevision(
    envelopeB,
    options,
    {
      expectedRevisionId: localSave.revisionId,
      decisions: [{
        conflictId: conflictB.conflictId,
        choice: 'keep-local'
      }]
    }
  );
  assert.equal(
    savedB.project.items[openingId].title,
    'Locally preferred opening'
  );

  const envelopeC = envelope({
    ...planB,
    teamNotes: 'Community-only change C'
  }, { syncVersion: 5 });
  const reviewC = await coordinator.propose(envelopeC, options);
  assert.equal(reviewC.reconciliation.conflictCount, 0);
  const savedC = await coordinator.replacePlanRevision(
    envelopeC,
    options,
    {
      expectedRevisionId: savedB.revisionId,
      decisions: []
    }
  );
  assert.equal(
    savedC.project.items[openingId].title,
    'Locally preferred opening'
  );
  assert.equal(
    savedC.project.planning.reconciliationBaseline.planRevision,
    envelopeC.revision
  );
  assert.equal(
    savedC.project.planning.teamNotes,
    'Community-only change C'
  );
});

test('Community parent deletion with local descendants cannot erase them without an explicit choice', async t => {
  const { coordinator, projectStore, options } = await harness(t);
  const first = await coordinator.importPlan(envelope(), options);
  const openingId = first.project.rootItemIds[0];
  const local = addGroupItem(first.project, {
    id: 'local-sermon-production',
    title: 'Local sermon production cues',
    groupKind: 'custom',
    parentId: openingId,
    now: NOW
  });
  const localSave = await projectStore.save(local, {
    expectedRevisionId: first.revisionId,
    reason: 'local-descendant'
  });
  const nextEnvelope = envelope(plan({
    entries: [{
      id: 'closing',
      kind: 'section',
      title: 'Closing'
    }]
  }), { syncVersion: 4 });
  const reviewed = await coordinator.propose(nextEnvelope, options);
  const parentConflict = reviewed.reconciliation.conflicts.find(conflict =>
    conflict.kind === 'COMMUNITY_PARENT_DELETED_WITH_LOCAL_CHILDREN');
  assert.ok(parentConflict);

  const decisions = reviewed.reconciliation.conflicts.map(conflict => ({
    conflictId: conflict.conflictId,
    choice: conflict.conflictId === parentConflict.conflictId
      ? 'keep-local'
      : 'keep-local'
  }));
  const reconciled = await coordinator.replacePlanRevision(
    nextEnvelope,
    options,
    {
      expectedRevisionId: localSave.revisionId,
      decisions
    }
  );
  assert.ok(reconciled.project.items['local-sermon-production']);
  assert.ok(reconciled.project.items[openingId]);
});

test('an explicit kept child survives and is lifted when its deleted parent uses Community', async t => {
  const { coordinator, projectStore, options } = await harness(t);
  const first = await coordinator.importPlan(envelope(), options);
  const openingId = first.project.rootItemIds[0];
  const sermonGroup = Object.values(first.project.items).find(item =>
    item.kind === 'group' && item.groupKind === 'sermon');
  const withLocalGrandchild = addGroupItem(first.project, {
    id: 'local-sermon-detail',
    title: 'Local sermon detail',
    groupKind: 'custom',
    parentId: sermonGroup.id,
    now: NOW
  });
  const locallyEdited = updateGroupItem(withLocalGrandchild, {
    itemId: sermonGroup.id,
    title: 'Locally edited sermon group',
    now: NOW
  });
  const localSave = await projectStore.save(locallyEdited, {
    expectedRevisionId: first.revisionId,
    reason: 'local-child-under-deleted-parent'
  });
  const nextEnvelope = envelope(plan({
    entries: [{
      id: 'closing',
      kind: 'section',
      title: 'Closing'
    }]
  }), { syncVersion: 4 });
  const reviewed = await coordinator.propose(nextEnvelope, options);
  const parentConflict = reviewed.reconciliation.conflicts.find(conflict =>
    conflict.itemId === openingId);
  const childConflict = reviewed.reconciliation.conflicts.find(conflict =>
    conflict.itemId === sermonGroup.id);
  assert.ok(parentConflict);
  assert.ok(childConflict);

  const reconciled = await coordinator.replacePlanRevision(
    nextEnvelope,
    options,
    {
      expectedRevisionId: localSave.revisionId,
      decisions: reviewed.reconciliation.conflicts.map(conflict => ({
        conflictId: conflict.conflictId,
        choice: conflict.conflictId === parentConflict.conflictId
          ? 'use-community'
          : 'keep-local'
      }))
    }
  );
  assert.equal(reconciled.project.items[openingId], undefined);
  assert.equal(
    reconciled.project.items[sermonGroup.id].title,
    'Locally edited sermon group'
  );
  assert.ok(reconciled.project.rootItemIds.includes(sermonGroup.id));
  assert.ok(reconciled.project.items['local-sermon-detail']);
  assert.ok(
    reconciled.project.items[sermonGroup.id].childIds.includes(
      'local-sermon-detail'
    )
  );
});

test('removing only a Community section reparents its retained managed entries instead of deleting them', async t => {
  const { coordinator, options } = await harness(t);
  const first = await coordinator.importPlan(envelope(), options);
  const openingId = first.project.rootItemIds[0];
  const retainedItemIds = [...first.project.items[openingId].childIds];
  assert.equal(retainedItemIds.length, 3);

  const nextEnvelope = envelope(plan({
    entries: plan().entries.filter(entry => entry.id !== 'opening')
  }), { syncVersion: 4 });
  const reviewed = await coordinator.propose(nextEnvelope, options);
  assert.equal(reviewed.reconciliation.conflictCount, 0);

  const reconciled = await coordinator.replacePlanRevision(
    nextEnvelope,
    options,
    {
      expectedRevisionId: first.revisionId,
      decisions: []
    }
  );
  assert.equal(reconciled.project.items[openingId], undefined);
  assert.deepEqual(reconciled.project.rootItemIds, retainedItemIds);
  for (const itemId of retainedItemIds) {
    assert.ok(
      reconciled.project.items[itemId],
      `retained Community item ${itemId} must survive section deletion`
    );
  }
});

test('Community deletion of a locally moved managed item requires an explicit choice', async t => {
  const { coordinator, projectStore, options } = await harness(t);
  const first = await coordinator.importPlan(envelope(), options);
  const openingId = first.project.rootItemIds[0];
  const songId = first.project.items[openingId].childIds[0];
  const moved = moveProjectItem(first.project, {
    itemId: songId,
    targetParentId: null,
    targetIndex: 1
  });
  const localSave = await projectStore.save(moved, {
    expectedRevisionId: first.revisionId,
    reason: 'local-managed-item-move'
  });
  const nextEnvelope = envelope(plan({
    entries: plan().entries.filter(entry => entry.id !== 'song-grace')
  }), { syncVersion: 4 });

  const reviewed = await coordinator.propose(nextEnvelope, options);
  const deletionConflict = reviewed.reconciliation.conflicts.find(conflict =>
    conflict.itemId === songId
    && conflict.kind === 'COMMUNITY_ITEM_DELETED_AFTER_LOCAL_CHANGE');
  assert.ok(deletionConflict);

  const reconciled = await coordinator.replacePlanRevision(
    nextEnvelope,
    options,
    {
      expectedRevisionId: localSave.revisionId,
      decisions: reviewed.reconciliation.conflicts.map(conflict => ({
        conflictId: conflict.conflictId,
        choice: 'keep-local'
      }))
    }
  );
  assert.ok(reconciled.project.items[songId]);
  assert.equal(reconciled.project.rootItemIds[1], songId);
});

test('Community deletion of a locally reordered managed item requires an explicit choice', async t => {
  const { coordinator, projectStore, options } = await harness(t);
  const first = await coordinator.importPlan(envelope(), options);
  const openingId = first.project.rootItemIds[0];
  const [songId, readingId] = first.project.items[openingId].childIds;
  const reordered = moveProjectItem(first.project, {
    itemId: songId,
    targetParentId: openingId,
    targetIndex: 1
  });
  const localSave = await projectStore.save(reordered, {
    expectedRevisionId: first.revisionId,
    reason: 'local-managed-item-reorder'
  });
  const nextEnvelope = envelope(plan({
    entries: plan().entries.filter(entry => entry.id !== 'song-grace')
  }), { syncVersion: 4 });

  const reviewed = await coordinator.propose(nextEnvelope, options);
  const deletionConflict = reviewed.reconciliation.conflicts.find(conflict =>
    conflict.itemId === songId
    && conflict.kind === 'COMMUNITY_ITEM_DELETED_AFTER_LOCAL_CHANGE');
  assert.ok(deletionConflict);
  const reconciled = await coordinator.replacePlanRevision(
    nextEnvelope,
    options,
    {
      expectedRevisionId: localSave.revisionId,
      decisions: reviewed.reconciliation.conflicts.map(conflict => ({
        conflictId: conflict.conflictId,
        choice: 'keep-local'
      }))
    }
  );
  assert.deepEqual(
    reconciled.project.items[openingId].childIds.slice(0, 2),
    [readingId, songId]
  );
});

test('choosing Community restores a locally deleted changed item to its exact section and order', async t => {
  const { coordinator, projectStore, options } = await harness(t);
  const first = await coordinator.importPlan(envelope(), options);
  const openingId = first.project.rootItemIds[0];
  const originalOrder = [...first.project.items[openingId].childIds];
  const readingId = originalOrder[1];
  const deleted = removeProjectItemAndDescendants(first.project, readingId);
  const localSave = await projectStore.save(deleted, {
    expectedRevisionId: first.revisionId,
    reason: 'local-reading-delete'
  });
  const nextEnvelope = envelope(plan({
    entries: plan().entries.map(entry =>
      entry.id === 'reading'
        ? { ...entry, title: 'Community changed reading' }
        : entry)
  }), { syncVersion: 4 });
  const reviewed = await coordinator.propose(nextEnvelope, options);
  const restoreConflict = reviewed.reconciliation.conflicts.find(conflict =>
    conflict.itemId === readingId
    && conflict.kind === 'LOCAL_ITEM_DELETED_AFTER_COMMUNITY_CHANGE');
  assert.ok(restoreConflict);

  const reconciled = await coordinator.replacePlanRevision(
    nextEnvelope,
    options,
    {
      expectedRevisionId: localSave.revisionId,
      decisions: reviewed.reconciliation.conflicts.map(conflict => ({
        conflictId: conflict.conflictId,
        choice: conflict.conflictId === restoreConflict.conflictId
          ? 'use-community'
          : 'keep-local'
      }))
    }
  );
  assert.equal(
    reconciled.project.items[readingId].title,
    'Community changed reading'
  );
  assert.deepEqual(
    reconciled.project.items[openingId].childIds,
    originalOrder
  );
});

test('choosing Community restores a locally deleted changed group with its unchanged children', async t => {
  const { coordinator, projectStore, options } = await harness(t);
  const first = await coordinator.importPlan(envelope(), options);
  const openingId = first.project.rootItemIds[0];
  const originalChildren = [...first.project.items[openingId].childIds];
  const deleted = removeProjectItemAndDescendants(first.project, openingId);
  const localSave = await projectStore.save(deleted, {
    expectedRevisionId: first.revisionId,
    reason: 'local-section-delete'
  });
  const nextEnvelope = envelope(plan({
    entries: plan().entries.map(entry =>
      entry.id === 'opening'
        ? { ...entry, title: 'Community restored opening' }
        : entry)
  }), { syncVersion: 4 });
  const reviewed = await coordinator.propose(nextEnvelope, options);
  const restoreConflict = reviewed.reconciliation.conflicts.find(conflict =>
    conflict.itemId === openingId
    && conflict.kind === 'LOCAL_ITEM_DELETED_AFTER_COMMUNITY_CHANGE');
  assert.ok(restoreConflict);

  const reconciled = await coordinator.replacePlanRevision(
    nextEnvelope,
    options,
    {
      expectedRevisionId: localSave.revisionId,
      decisions: reviewed.reconciliation.conflicts.map(conflict => ({
        conflictId: conflict.conflictId,
        choice: conflict.conflictId === restoreConflict.conflictId
          ? 'use-community'
          : 'keep-local'
      }))
    }
  );
  assert.equal(
    reconciled.project.items[openingId].title,
    'Community restored opening'
  );
  assert.deepEqual(
    reconciled.project.items[openingId].childIds,
    originalChildren
  );
  for (const childId of originalChildren) {
    assert.ok(reconciled.project.items[childId]);
  }
});

test('different local and Community reorders surface one structure choice', async t => {
  const { coordinator, projectStore, options } = await harness(t);
  const first = await coordinator.importPlan(envelope(), options);
  const openingId = first.project.rootItemIds[0];
  const opening = first.project.items[openingId];
  const [songId, readingId, sermonId] = opening.childIds;
  const locallyMoved = moveProjectItem(first.project, {
    itemId: readingId,
    targetParentId: openingId,
    targetIndex: 0
  });
  const localSave = await projectStore.save(locallyMoved, {
    expectedRevisionId: first.revisionId,
    reason: 'local-order'
  });
  const originalEntries = plan().entries;
  const nextEnvelope = envelope(plan({
    entries: [
      originalEntries[0],
      originalEntries[1],
      originalEntries[3],
      originalEntries[2]
    ]
  }), { syncVersion: 4 });
  const reviewed = await coordinator.propose(nextEnvelope, options);
  const orderConflict = reviewed.reconciliation.conflicts.find(conflict =>
    conflict.kind === 'LOCAL_AND_COMMUNITY_STRUCTURE_CHANGED'
    && conflict.itemId === openingId);
  assert.ok(orderConflict);

  const reconciled = await coordinator.replacePlanRevision(
    nextEnvelope,
    options,
    {
      expectedRevisionId: localSave.revisionId,
      decisions: reviewed.reconciliation.conflicts.map(conflict => ({
        conflictId: conflict.conflictId,
        choice: 'keep-local'
      }))
    }
  );
  assert.deepEqual(
    reconciled.project.items[openingId].childIds
      .filter(itemId => [songId, readingId, sermonId].includes(itemId)),
    [readingId, songId, sermonId]
  );
});

test('different positions for the same cross-parent move surface an order conflict', async t => {
  const { coordinator, projectStore, options } = await harness(t);
  const initialPlan = plan({
    entries: [
      plan().entries[0],
      plan().entries[1],
      {
        id: 'closing',
        kind: 'section',
        title: 'Closing'
      },
      plan().entries[2],
      plan().entries[3]
    ]
  });
  const first = await coordinator.importPlan(
    envelope(initialPlan),
    options
  );
  const openingId = first.project.rootItemIds[0];
  const closingId = first.project.rootItemIds[1];
  const songId = first.project.items[openingId].childIds[0];
  const localMove = moveProjectItem(first.project, {
    itemId: songId,
    targetParentId: closingId,
    targetIndex: 0
  });
  const localSave = await projectStore.save(localMove, {
    expectedRevisionId: first.revisionId,
    reason: 'local-cross-parent-position'
  });
  const nextPlan = plan({
    entries: [
      plan().entries[0],
      {
        id: 'closing',
        kind: 'section',
        title: 'Closing'
      },
      plan().entries[2],
      plan().entries[1],
      plan().entries[3]
    ]
  });
  const nextEnvelope = envelope(nextPlan, { syncVersion: 4 });
  const reviewed = await coordinator.propose(nextEnvelope, options);
  const orderConflict = reviewed.reconciliation.conflicts.find(conflict =>
    conflict.itemId === closingId
    && conflict.kind === 'LOCAL_AND_COMMUNITY_STRUCTURE_CHANGED');
  assert.ok(orderConflict);

  const reconciled = await coordinator.replacePlanRevision(
    nextEnvelope,
    options,
    {
      expectedRevisionId: localSave.revisionId,
      decisions: reviewed.reconciliation.conflicts.map(conflict => ({
        conflictId: conflict.conflictId,
        choice: 'keep-local'
      }))
    }
  );
  assert.equal(reconciled.project.items[closingId].childIds[0], songId);
});

test('local reorder versus Community cross-parent move is one explicit structure choice', async t => {
  for (const choice of ['keep-local', 'use-community']) {
    await t.test(choice, async subtest => {
      const sourceEntries = plan().entries;
      const openingEntry = sourceEntries[0];
      const songEntry = sourceEntries[1];
      const readingEntry = sourceEntries[2];
      const sermonEntry = sourceEntries[3];
      const closingEntry = {
        id: 'closing',
        kind: 'section',
        title: 'Closing'
      };
      const initialPlan = plan({
        entries: [
          openingEntry,
          songEntry,
          readingEntry,
          closingEntry,
          sermonEntry
        ]
      });
      const { coordinator, projectStore, options } =
        await harness(subtest);
      const first = await coordinator.importPlan(
        envelope(initialPlan),
        options
      );
      const openingId = managedItemId('opening');
      const closingId = managedItemId('closing');
      const songId = managedItemId('song-grace');
      const readingId = managedItemId('reading');
      const sermonId = managedItemId('sermon');
      const locallyReordered = moveProjectItem(first.project, {
        itemId: songId,
        targetParentId: openingId,
        targetIndex: 1
      });
      const localSave = await projectStore.save(locallyReordered, {
        expectedRevisionId: first.revisionId,
        reason: `local-reorder-remote-cross-parent-${choice}`
      });
      const nextEnvelope = envelope(plan({
        entries: [
          openingEntry,
          readingEntry,
          closingEntry,
          sermonEntry,
          songEntry
        ]
      }), { syncVersion: 4 });
      const reviewed = await coordinator.propose(nextEnvelope, options);
      const structureConflict =
        reviewed.reconciliation.conflicts.find(conflict =>
          conflict.kind === 'LOCAL_AND_COMMUNITY_STRUCTURE_CHANGED'
          && conflict.itemId === songId);
      assert.ok(structureConflict);

      const reconciled = await coordinator.replacePlanRevision(
        nextEnvelope,
        options,
        {
          expectedRevisionId: localSave.revisionId,
          decisions: reviewed.reconciliation.conflicts.map(conflict => ({
            conflictId: conflict.conflictId,
            choice: conflict.conflictId === structureConflict.conflictId
              ? choice
              : 'keep-local'
          }))
        }
      );
      const expectedParentId = choice === 'keep-local'
        ? openingId
        : closingId;
      assert.equal(
        projectItemParentId(reconciled.project, songId),
        expectedParentId
      );
      assert.deepEqual(
        reconciled.project.items[expectedParentId].childIds.filter(itemId =>
          [songId, readingId, sermonId].includes(itemId)),
        choice === 'keep-local'
          ? [readingId, songId]
          : [sermonId, songId]
      );
    });
  }
});

test('local cross-parent move versus Community reorder is one explicit structure choice', async t => {
  for (const choice of ['keep-local', 'use-community']) {
    await t.test(choice, async subtest => {
      const sourceEntries = plan().entries;
      const openingEntry = sourceEntries[0];
      const songEntry = sourceEntries[1];
      const readingEntry = sourceEntries[2];
      const sermonEntry = sourceEntries[3];
      const closingEntry = {
        id: 'closing',
        kind: 'section',
        title: 'Closing'
      };
      const initialPlan = plan({
        entries: [
          openingEntry,
          songEntry,
          readingEntry,
          closingEntry,
          sermonEntry
        ]
      });
      const { coordinator, projectStore, options } =
        await harness(subtest);
      const first = await coordinator.importPlan(
        envelope(initialPlan),
        options
      );
      const openingId = managedItemId('opening');
      const closingId = managedItemId('closing');
      const songId = managedItemId('song-grace');
      const readingId = managedItemId('reading');
      const sermonId = managedItemId('sermon');
      const locallyMoved = moveProjectItem(first.project, {
        itemId: songId,
        targetParentId: closingId,
        targetIndex: 1
      });
      const localSave = await projectStore.save(locallyMoved, {
        expectedRevisionId: first.revisionId,
        reason: `local-cross-parent-remote-reorder-${choice}`
      });
      const nextEnvelope = envelope(plan({
        entries: [
          openingEntry,
          readingEntry,
          songEntry,
          closingEntry,
          sermonEntry
        ]
      }), { syncVersion: 4 });
      const reviewed = await coordinator.propose(nextEnvelope, options);
      const structureConflict =
        reviewed.reconciliation.conflicts.find(conflict =>
          conflict.kind === 'LOCAL_AND_COMMUNITY_STRUCTURE_CHANGED'
          && conflict.itemId === songId);
      assert.ok(structureConflict);

      const reconciled = await coordinator.replacePlanRevision(
        nextEnvelope,
        options,
        {
          expectedRevisionId: localSave.revisionId,
          decisions: reviewed.reconciliation.conflicts.map(conflict => ({
            conflictId: conflict.conflictId,
            choice: conflict.conflictId === structureConflict.conflictId
              ? choice
              : 'keep-local'
          }))
        }
      );
      const expectedParentId = choice === 'keep-local'
        ? closingId
        : openingId;
      assert.equal(
        projectItemParentId(reconciled.project, songId),
        expectedParentId
      );
      assert.deepEqual(
        reconciled.project.items[expectedParentId].childIds.filter(itemId =>
          [songId, readingId, sermonId].includes(itemId)),
        choice === 'keep-local'
          ? [sermonId, songId]
          : [readingId, songId]
      );
    });
  }
});

test('Community entry kind changes conflict with each form of local-only work', async t => {
  await t.test('operator notes', async subtest => {
    const entryId = 'kind-shift';
    const { coordinator, projectStore, options } = await harness(subtest);
    const first = await coordinator.importPlan(envelope(plan({
      entries: [{
        id: entryId,
        kind: 'section',
        title: 'Local section'
      }]
    })), options);
    const itemId = managedItemId(entryId);
    const locallyNoted = updateGroupItem(first.project, {
      itemId,
      operatorNotes: 'Do not lose this local operator note.',
      now: NOW
    });
    await projectStore.save(locallyNoted, {
      expectedRevisionId: first.revisionId,
      reason: 'local-operator-note-before-kind-change'
    });
    const reviewed = await coordinator.propose(envelope(plan({
      entries: [{
        ...plan().entries.find(entry => entry.kind === 'scripture'),
        id: entryId,
        title: 'Community Scripture'
      }]
    }), { syncVersion: 4 }), options);
    const kindConflict = reviewed.reconciliation.conflicts.find(conflict =>
      conflict.kind === 'COMMUNITY_ENTRY_KIND_CHANGED_AFTER_LOCAL_CHANGE'
      && conflict.itemId === itemId);
    assert.ok(kindConflict);
  });

  await t.test('song arrangement', async subtest => {
    const entryId = 'kind-shift';
    const sourceEntries = plan().entries;
    const { coordinator, projectStore, options } = await harness(subtest);
    const first = await coordinator.importPlan(envelope(plan({
      entries: [
        sourceEntries[0],
        {
          ...sourceEntries[1],
          id: entryId,
          title: 'Locally arranged song'
        }
      ]
    })), options);
    const itemId = managedItemId(entryId);
    const songItem = first.project.items[itemId];
    const locallyArranged = updateSongArrangement(first.project, {
      itemId,
      arrangement: [...songItem.arrangement].reverse(),
      now: NOW
    });
    await projectStore.save(locallyArranged, {
      expectedRevisionId: first.revisionId,
      reason: 'local-arrangement-before-kind-change'
    });
    const reviewed = await coordinator.propose(envelope(plan({
      entries: [
        sourceEntries[0],
        {
          ...sourceEntries[2],
          id: entryId,
          title: 'Community Scripture'
        }
      ]
    }), { syncVersion: 4 }), options);
    const kindConflict = reviewed.reconciliation.conflicts.find(conflict =>
      conflict.kind === 'COMMUNITY_ENTRY_KIND_CHANGED_AFTER_LOCAL_CHANGE'
      && conflict.itemId === itemId);
    assert.ok(kindConflict);
  });

  await t.test('group with local descendants', async subtest => {
    const entryId = 'kind-shift';
    const { coordinator, projectStore, options } = await harness(subtest);
    const first = await coordinator.importPlan(envelope(plan({
      entries: [{
        id: entryId,
        kind: 'section',
        title: 'Local parent'
      }]
    })), options);
    const itemId = managedItemId(entryId);
    const withLocalDescendant = addGroupItem(first.project, {
      id: 'local-kind-change-descendant',
      title: 'Local descendant',
      groupKind: 'custom',
      parentId: itemId,
      now: NOW
    });
    await projectStore.save(withLocalDescendant, {
      expectedRevisionId: first.revisionId,
      reason: 'local-descendant-before-kind-change'
    });
    const reviewed = await coordinator.propose(envelope(plan({
      entries: [{
        ...plan().entries.find(entry => entry.kind === 'scripture'),
        id: entryId,
        title: 'Community Scripture'
      }]
    }), { syncVersion: 4 }), options);
    const kindConflict = reviewed.reconciliation.conflicts.find(conflict =>
      conflict.kind === 'COMMUNITY_ENTRY_KIND_CHANGED_AFTER_LOCAL_CHANGE'
      && conflict.itemId === itemId);
    assert.ok(kindConflict);
  });
});

test('nested managed work survives when its Community-deleted ancestor is accepted', async t => {
  const sourceEntries = plan().entries;
  const initialPlan = plan({
    entries: [{
      id: 'ancestor-a',
      kind: 'section',
      title: 'Ancestor A'
    }, {
      ...sourceEntries[1],
      id: 'nested-x',
      title: 'Nested managed X'
    }, {
      ...sourceEntries[3],
      id: 'group-b',
      title: 'Managed group B'
    }]
  });
  const nextEnvelope = envelope(plan({
    entries: [{
      id: 'closing',
      kind: 'section',
      title: 'Closing'
    }]
  }), { syncVersion: 4 });
  const ancestorId = managedItemId('ancestor-a');
  const groupId = managedItemId('group-b');
  const nestedId = managedItemId('nested-x');

  await t.test('nested topology edit', async subtest => {
    const { coordinator, projectStore, options } =
      await harness(subtest);
    const first = await coordinator.importPlan(
      envelope(initialPlan),
      options
    );
    const nested = moveProjectItem(first.project, {
      itemId: nestedId,
      targetParentId: groupId,
      targetIndex: 0
    });
    const localSave = await projectStore.save(nested, {
      expectedRevisionId: first.revisionId,
      reason: 'nested-managed-topology-edit'
    });
    const reviewed = await coordinator.propose(nextEnvelope, options);
    const ancestorConflict =
      reviewed.reconciliation.conflicts.find(conflict =>
        conflict.itemId === ancestorId
        && conflict.kind === 'COMMUNITY_PARENT_DELETED_WITH_LOCAL_CHILDREN');
    const groupConflict =
      reviewed.reconciliation.conflicts.find(conflict =>
        conflict.itemId === groupId
        && conflict.kind === 'COMMUNITY_PARENT_DELETED_WITH_LOCAL_CHILDREN');
    const nestedConflict =
      reviewed.reconciliation.conflicts.find(conflict =>
        conflict.itemId === nestedId
        && conflict.kind === 'COMMUNITY_ITEM_DELETED_AFTER_LOCAL_CHANGE');
    assert.ok(ancestorConflict);
    assert.ok(groupConflict);
    assert.ok(nestedConflict);

    const reconciled = await coordinator.replacePlanRevision(
      nextEnvelope,
      options,
      {
        expectedRevisionId: localSave.revisionId,
        decisions: reviewed.reconciliation.conflicts.map(conflict => ({
          conflictId: conflict.conflictId,
          choice: conflict.conflictId === ancestorConflict.conflictId
            ? 'use-community'
            : 'keep-local'
        }))
      }
    );
    assert.equal(reconciled.project.items[ancestorId], undefined);
    assert.equal(projectItemParentId(reconciled.project, groupId), null);
    assert.equal(
      projectItemParentId(reconciled.project, nestedId),
      groupId
    );
    assert.deepEqual(
      reconciled.project.items[groupId].childIds,
      [nestedId]
    );
  });

  await t.test('nested managed deletion', async subtest => {
    const { coordinator, projectStore, options } =
      await harness(subtest);
    const first = await coordinator.importPlan(
      envelope(initialPlan),
      options
    );
    const nested = moveProjectItem(first.project, {
      itemId: nestedId,
      targetParentId: groupId,
      targetIndex: 0
    });
    const nestedBaseline = communityServicePlanBaselineFromProject(
      nested,
      initialPlan.entries
    );
    const rebased = bindCommunityServicePlanBaseline(
      nested,
      nestedBaseline
    );
    const baselineSave = await projectStore.save(rebased, {
      expectedRevisionId: first.revisionId,
      reason: 'nested-managed-baseline-fixture'
    });
    const locallyDeleted = removeProjectItemAndDescendants(
      baselineSave.project,
      nestedId
    );
    const localSave = await projectStore.save(locallyDeleted, {
      expectedRevisionId: baselineSave.revisionId,
      reason: 'nested-managed-deletion'
    });
    const reviewed = await coordinator.propose(nextEnvelope, options);
    const ancestorConflict =
      reviewed.reconciliation.conflicts.find(conflict =>
        conflict.itemId === ancestorId
        && conflict.kind === 'COMMUNITY_PARENT_DELETED_WITH_LOCAL_CHILDREN');
    const groupConflict =
      reviewed.reconciliation.conflicts.find(conflict =>
        conflict.itemId === groupId
        && conflict.kind === 'COMMUNITY_PARENT_DELETED_WITH_LOCAL_CHILDREN');
    assert.ok(ancestorConflict);
    assert.ok(groupConflict);

    const reconciled = await coordinator.replacePlanRevision(
      nextEnvelope,
      options,
      {
        expectedRevisionId: localSave.revisionId,
        decisions: reviewed.reconciliation.conflicts.map(conflict => ({
          conflictId: conflict.conflictId,
          choice: conflict.conflictId === ancestorConflict.conflictId
            ? 'use-community'
            : 'keep-local'
        }))
      }
    );
    assert.equal(reconciled.project.items[ancestorId], undefined);
    assert.equal(projectItemParentId(reconciled.project, groupId), null);
    assert.deepEqual(reconciled.project.items[groupId].childIds, []);
    assert.equal(reconciled.project.items[nestedId], undefined);
  });
});

test('a locally deleted managed group is one atomic Community subtree choice', async t => {
  for (const choice of ['keep-local', 'use-community']) {
    await t.test(choice, async subtest => {
      const sourceEntries = plan().entries;
      const initialPlan = plan({
        entries: [{
          id: 'group-a',
          kind: 'section',
          title: 'Group A'
        }, {
          ...sourceEntries[1],
          id: 'child-x',
          title: 'Original child X'
        }]
      });
      const { coordinator, projectStore, options } =
        await harness(subtest);
      const first = await coordinator.importPlan(
        envelope(initialPlan),
        options
      );
      const groupId = managedItemId('group-a');
      const childXId = managedItemId('child-x');
      const childYId = managedItemId('child-y');
      const locallyDeleted = removeProjectItemAndDescendants(
        first.project,
        groupId
      );
      const localSave = await projectStore.save(locallyDeleted, {
        expectedRevisionId: first.revisionId,
        reason: `local-whole-group-deletion-${choice}`
      });
      const nextEnvelope = envelope(plan({
        entries: [{
          id: 'group-a',
          kind: 'section',
          title: 'Group A'
        }, {
          ...sourceEntries[1],
          id: 'child-x',
          title: 'Community changed child X'
        }, {
          ...sourceEntries[2],
          id: 'child-y',
          title: 'Community added child Y'
        }]
      }), { syncVersion: 4 });
      const reviewed = await coordinator.propose(nextEnvelope, options);
      assert.ok(
        reviewed.reconciliation,
        JSON.stringify(reviewed, null, 2)
      );
      assert.equal(reviewed.reconciliation.conflictCount, 1);
      const [subtreeConflict] = reviewed.reconciliation.conflicts;
      assert.equal(
        subtreeConflict.kind,
        'LOCAL_ITEM_DELETED_AFTER_COMMUNITY_CHANGE'
      );
      assert.equal(subtreeConflict.itemId, groupId);

      const reconciled = await coordinator.replacePlanRevision(
        nextEnvelope,
        options,
        {
          expectedRevisionId: localSave.revisionId,
          decisions: [{
            conflictId: subtreeConflict.conflictId,
            choice
          }]
        }
      );
      if (choice === 'keep-local') {
        assert.equal(reconciled.project.items[groupId], undefined);
        assert.equal(reconciled.project.items[childXId], undefined);
        assert.equal(reconciled.project.items[childYId], undefined);
        assert.equal(reconciled.project.rootItemIds.includes(childXId), false);
        assert.equal(reconciled.project.rootItemIds.includes(childYId), false);
      } else {
        assert.deepEqual(
          reconciled.project.items[groupId].childIds,
          [childXId, childYId]
        );
        assert.equal(
          reconciled.project.items[childXId].title,
          'Community changed child X'
        );
        assert.equal(
          projectItemParentId(reconciled.project, childYId),
          groupId
        );
      }
    });
  }
});

test('group-to-leaf Community choice lifts retained local descendants to the nearest group', async t => {
  const sourceEntries = plan().entries;
  const initialPlan = plan({
    entries: [{
      id: 'outer',
      kind: 'section',
      title: 'Outer section'
    }, {
      ...sourceEntries[3],
      id: 'kind-shift',
      title: 'Sermon group becoming Scripture'
    }]
  });
  const { coordinator, projectStore, options } = await harness(t);
  const first = await coordinator.importPlan(
    envelope(initialPlan),
    options
  );
  const outerId = managedItemId('outer');
  const changedId = managedItemId('kind-shift');
  let local = addGroupItem(first.project, {
    id: 'local-retained-child',
    title: 'Retained local child',
    groupKind: 'custom',
    parentId: changedId,
    now: NOW
  });
  local = addGroupItem(local, {
    id: 'local-retained-grandchild',
    title: 'Retained local grandchild',
    groupKind: 'custom',
    parentId: 'local-retained-child',
    now: NOW
  });
  const localSave = await projectStore.save(local, {
    expectedRevisionId: first.revisionId,
    reason: 'local-descendants-before-group-to-leaf'
  });
  const nextEnvelope = envelope(plan({
    entries: [{
      id: 'outer',
      kind: 'section',
      title: 'Outer section'
    }, {
      ...sourceEntries[2],
      id: 'kind-shift',
      title: 'Community Scripture leaf'
    }]
  }), { syncVersion: 4 });
  const reviewed = await coordinator.propose(nextEnvelope, options);
  const kindConflict = reviewed.reconciliation.conflicts.find(conflict =>
    conflict.kind === 'COMMUNITY_ENTRY_KIND_CHANGED_AFTER_LOCAL_CHANGE'
    && conflict.itemId === changedId);
  assert.ok(kindConflict);

  const reconciled = await coordinator.replacePlanRevision(
    nextEnvelope,
    options,
    {
      expectedRevisionId: localSave.revisionId,
      decisions: reviewed.reconciliation.conflicts.map(conflict => ({
        conflictId: conflict.conflictId,
        choice: conflict.conflictId === kindConflict.conflictId
          ? 'use-community'
          : 'keep-local'
      }))
    }
  );
  assert.doesNotThrow(() => normalizeServiceProject(reconciled.project));
  assert.equal(reconciled.project.items[changedId].kind, 'bible');
  assert.equal(projectItemParentId(reconciled.project, changedId), outerId);
  assert.equal(
    projectItemParentId(reconciled.project, 'local-retained-child'),
    outerId
  );
  assert.equal(
    projectItemParentId(reconciled.project, 'local-retained-grandchild'),
    'local-retained-child'
  );
});

test('local-only sermon references make a Community repin one shared explicit choice', async t => {
  for (const choice of ['keep-local', 'use-community']) {
    await t.test(choice, async subtest => {
      const primaryReference = sermonReference();
      const sermonState = {};
      let currentSermonRevision = SERMON_REVISION;
      let currentSermon = sermonDocument({
        references: [primaryReference]
      });
      const { coordinator, projectStore, options } =
        await harness(subtest, {
          sermonState,
          sermonRevisionProvider(sermonId, revision) {
            assert.equal(sermonId, currentSermon.id);
            assert.equal(revision, currentSermonRevision);
            return { sermon: currentSermon, revision };
          }
        });
      const first = await coordinator.importPlan(
        envelope(planV2()),
        options
      );
      const openingId = managedItemId('opening');
      const managedOwnerId = managedItemId('sermon');
      const managedReadingId = managedItemId('reading');
      const previousResourceId =
        first.project.items[managedOwnerId].sermonResourceId;
      let local = addBibleItem(first.project, {
        id: 'local-shared-sermon-reading',
        title: 'Local-only sermon reading',
        range: first.project.items[managedReadingId].range,
        passagesByChannel: Object.fromEntries(
          first.project.channelIds.map(channelId => [
            channelId,
            biblePassage()
          ])
        ),
        sermonReading: {
          sermonResourceId: previousResourceId,
          referenceId: primaryReference.id,
          translationId: 'BSB',
          chunkIndex: 0,
          chunkCount: 1
        },
        parentId: openingId,
        now: NOW
      });
      local = addGroupItem(local, {
        id: 'local-shared-sermon-owner',
        title: 'Local-only sermon owner',
        groupKind: 'sermon',
        sermonResourceId: previousResourceId,
        parentId: openingId,
        now: NOW
      });
      const localSave = await projectStore.save(local, {
        expectedRevisionId: first.revisionId,
        reason: `local-shared-sermon-references-${choice}`
      });

      currentSermonRevision = '9'.repeat(64);
      currentSermon = {
        ...currentSermon,
        titles: { en: 'Community revision with local shared users' }
      };
      Object.assign(sermonState, {
        syncVersion: 5,
        localRevision: currentSermonRevision,
        remoteRevision: currentSermonRevision
      });
      const nextEnvelope = envelope(planV2({
        entries: planV2().entries.map(entry =>
          entry.id === 'sermon'
            ? {
                ...entry,
                expectedRevision: currentSermonRevision,
                expectedSyncVersion: 5
              }
            : entry)
      }), { syncVersion: 5 });
      const reviewed = await coordinator.propose(nextEnvelope, options);
      const pinConflict = reviewed.reconciliation.conflicts.find(conflict =>
        conflict.kind === 'COMMUNITY_SERMON_PIN_CHANGED_WITH_LOCAL_WORK');
      assert.ok(pinConflict);

      const reconciled = await coordinator.replacePlanRevision(
        nextEnvelope,
        options,
        {
          expectedRevisionId: localSave.revisionId,
          decisions: reviewed.reconciliation.conflicts.map(conflict => ({
            conflictId: conflict.conflictId,
            choice: conflict.conflictId === pinConflict.conflictId
              ? choice
              : 'keep-local'
          }))
        }
      );
      const expectedResourceId = choice === 'keep-local'
        ? previousResourceId
        : reconciled.project.items[managedOwnerId].sermonResourceId;
      if (choice === 'use-community') {
        assert.notEqual(expectedResourceId, previousResourceId);
      }
      for (const ownerId of [
        managedOwnerId,
        'local-shared-sermon-owner'
      ]) {
        assert.equal(
          reconciled.project.items[ownerId].sermonResourceId,
          expectedResourceId
        );
      }
      for (const readingId of [
        managedReadingId,
        'local-shared-sermon-reading'
      ]) {
        assert.equal(
          reconciled.project.items[readingId]
            .sermonReading.sermonResourceId,
          expectedResourceId
        );
      }
      if (choice === 'use-community') {
        assert.equal(
          reconciled.project.resources[previousResourceId],
          undefined
        );
      }
    });
  }
});

test('overlapping A-to-B and B-to-C sermon repins fail closed without mutation', async t => {
  const revisions = {
    a: '1'.repeat(64),
    b: '2'.repeat(64),
    c: '3'.repeat(64)
  };
  const documents = {
    a: {
      ...sermonDocument(),
      id: 'sermon-chain',
      titles: { en: 'Sermon revision A' }
    },
    b: {
      ...sermonDocument(),
      id: 'sermon-chain',
      titles: { en: 'Sermon revision B' }
    },
    c: {
      ...sermonDocument(),
      id: 'sermon-chain',
      titles: { en: 'Sermon revision C' }
    }
  };
  const records = {
    'sync-sermon-a': { document: documents.a, revision: revisions.a },
    'sync-sermon-b': { document: documents.b, revision: revisions.b },
    'sync-sermon-c': { document: documents.c, revision: revisions.c }
  };
  const { coordinator, projectStore, options } = await harness(t, {
    sermonStateProvider(syncId) {
      const record = records[syncId];
      assert.ok(record, `unexpected sermon sync id ${syncId}`);
      return {
        syncId,
        localSermonId: record.document.id,
        syncVersion: 1,
        localRevision: record.revision,
        remoteRevision: record.revision,
        conflict: null
      };
    },
    sermonRevisionProvider(sermonId, revision) {
      const record = Object.values(records).find(candidate =>
        candidate.document.id === sermonId
        && candidate.revision === revision);
      assert.ok(record, `missing chained sermon revision ${revision}`);
      return { sermon: record.document, revision };
    }
  });
  const sermonEntry = ({
    id,
    title,
    syncId,
    revision
  }) => ({
    id,
    kind: 'sermon',
    title,
    syncId,
    expectedRevision: revision,
    expectedSyncVersion: 1
  });
  const initialPlan = plan({
    entries: [{
      id: 'opening',
      kind: 'section',
      title: 'Opening'
    }, sermonEntry({
      id: 'owner-a',
      title: 'Owner A',
      syncId: 'sync-sermon-a',
      revision: revisions.a
    }), sermonEntry({
      id: 'owner-b',
      title: 'Owner B',
      syncId: 'sync-sermon-b',
      revision: revisions.b
    })]
  });
  const first = await coordinator.importPlan(
    envelope(initialPlan),
    options
  );
  const nextPlan = plan({
    entries: [{
      id: 'opening',
      kind: 'section',
      title: 'Opening'
    }, sermonEntry({
      id: 'owner-a',
      title: 'Owner A',
      syncId: 'sync-sermon-b',
      revision: revisions.b
    }), sermonEntry({
      id: 'owner-b',
      title: 'Owner B',
      syncId: 'sync-sermon-c',
      revision: revisions.c
    })]
  });
  const reviewed = await coordinator.propose(
    envelope(nextPlan, { syncVersion: 4 }),
    options
  );
  assert.equal(reviewed.status, 'blocked');
  assert.equal(reviewed.blockerCount, 1);
  assert.deepEqual(
    reviewed.blockers.map(blocker => blocker.code),
    ['COMMUNITY_SERMON_REPIN_SCOPE_OVERLAP']
  );
  assert.equal(
    (await projectStore.read(first.projectId)).revisionId,
    first.revisionId
  );
  assert.equal(
    (await projectStore.listRevisions(first.projectId)).total,
    1
  );
});

test('a stable sermon entry can replace one sermon identity with another atomically', async t => {
  const oldRevision = '4'.repeat(64);
  const nextRevision = '5'.repeat(64);
  const canonicalSermon = ({ id, title, prefix }) => ({
    ...sermonDocument({
      references: [sermonReference()]
    }),
    schemaVersion: 3,
    id,
    titles: { en: title },
    body: [{
      id: `${prefix}-body-en`,
      kind: 'manuscript',
      language: 'en',
      sourceId: null,
      sectionId: null,
      text: `${title} English paragraph.`
    }, {
      id: `${prefix}-body-ru`,
      kind: 'manuscript',
      language: 'ru',
      sourceId: null,
      sectionId: null,
      text: `${title} Russian paragraph.`
    }]
  });
  const oldDocument = canonicalSermon({
    id: 'sermon-identity-old',
    title: 'Original sermon identity',
    prefix: 'old'
  });
  const nextDocument = canonicalSermon({
    id: 'sermon-identity-next',
    title: 'Different sermon identity',
    prefix: 'next'
  });
  const records = {
    'sync-sermon-old': {
      document: oldDocument,
      revision: oldRevision
    },
    'sync-sermon-next': {
      document: nextDocument,
      revision: nextRevision
    }
  };
  const optionsForHarness = {
    sermonStateProvider(syncId) {
      const record = records[syncId];
      assert.ok(record, `unexpected identity sync id ${syncId}`);
      return {
        syncId,
        localSermonId: record.document.id,
        syncVersion: 1,
        localRevision: record.revision,
        remoteRevision: record.revision,
        conflict: null
      };
    },
    sermonRevisionProvider(sermonId, revision) {
      const record = Object.values(records).find(candidate =>
        candidate.document.id === sermonId
        && candidate.revision === revision);
      assert.ok(record, `missing sermon identity ${sermonId}:${revision}`);
      return { sermon: record.document, revision };
    }
  };
  const identityPlan = record => planV2({
    entries: planV2().entries.map(entry =>
      entry.id === 'sermon'
        ? {
            ...entry,
            syncId: record === records['sync-sermon-old']
              ? 'sync-sermon-old'
              : 'sync-sermon-next',
            expectedRevision: record.revision,
            expectedSyncVersion: 1
          }
        : entry)
  });

  await t.test('untouched owner and reading auto-replace', async subtest => {
    const { coordinator, options } = await harness(
      subtest,
      optionsForHarness
    );
    const first = await coordinator.importPlan(
      envelope(identityPlan(records['sync-sermon-old'])),
      options
    );
    const ownerId = managedItemId('sermon');
    const readingId = managedItemId('reading');
    const previousResourceId =
      first.project.items[ownerId].sermonResourceId;
    const originalPassages =
      first.project.items[readingId].passagesByChannel;
    const nextEnvelope = envelope(
      identityPlan(records['sync-sermon-next']),
      { syncVersion: 4 }
    );
    const reviewed = await coordinator.propose(nextEnvelope, options);
    assert.equal(reviewed.reconciliation.conflictCount, 0);

    const reconciled = await coordinator.replacePlanRevision(
      nextEnvelope,
      options,
      {
        expectedRevisionId: first.revisionId,
        decisions: []
      }
    );
    const nextResourceId =
      reconciled.project.items[ownerId].sermonResourceId;
    assert.notEqual(nextResourceId, previousResourceId);
    assert.equal(
      reconciled.project.resources[nextResourceId].document.id,
      nextDocument.id
    );
    assert.equal(
      reconciled.project.items[readingId]
        .sermonReading.sermonResourceId,
      nextResourceId
    );
    assert.deepEqual(
      reconciled.project.items[readingId].passagesByChannel,
      originalPassages
    );
    assert.equal(reconciled.project.resources[previousResourceId], undefined);
  });

  for (const choice of ['keep-local', 'use-community']) {
    await t.test(`local projected cue: ${choice}`, async subtest => {
      const { coordinator, projectStore, options } = await harness(
        subtest,
        optionsForHarness
      );
      const first = await coordinator.importPlan(
        envelope(identityPlan(records['sync-sermon-old'])),
        options
      );
      const ownerId = managedItemId('sermon');
      const readingId = managedItemId('reading');
      const previousResourceId =
        first.project.items[ownerId].sermonResourceId;
      const projection = buildCanonicalSermonBodyProjectionProposal({
        project: first.project,
        projectRevisionId: serviceProjectRevisionId(first.project),
        anchorItemId: ownerId,
        sermonId: oldDocument.id,
        sermonRevisionId:
          previousResourceId.slice('sha256:'.length),
        channelMappings: [{
          channelId: 'primary',
          mode: 'body-entry',
          bodyEntryId: 'old-body-en'
        }, {
          channelId: 'secondary',
          mode: 'body-entry',
          bodyEntryId: 'old-body-ru'
        }],
        now: NOW
      });
      const projected = applyCanonicalSermonBodyProjection({
        project: first.project,
        proposal: projection,
        decisions: {
          rows: [{
            rowId: 'local-projected-cue',
            action: 'insert',
            paragraphIdsByChannel: {
              primary: 'paragraph-001',
              secondary: 'paragraph-001'
            }
          }],
          skippedParagraphIdsByChannel: {
            primary: [],
            secondary: []
          }
        },
        confirmed: true,
        idFactory: ({ rowId }) => rowId,
        placementIndex: 0
      });
      const cueId = projected.insertedItemIds[0];
      const projectedCue = projected.project.items[cueId];
      assert.ok(
        projectedCue.sourceBodyProjection
      );
      const localSave = await projectStore.save(projected.project, {
        expectedRevisionId: first.revisionId,
        reason: `local-cue-before-sermon-identity-${choice}`
      });
      const nextEnvelope = envelope(
        identityPlan(records['sync-sermon-next']),
        { syncVersion: 4 }
      );
      const reviewed = await coordinator.propose(nextEnvelope, options);
      assert.equal(reviewed.reconciliation.conflictCount, 1);
      const [replacementConflict] =
        reviewed.reconciliation.conflicts;
      assert.equal(
        replacementConflict.kind,
        'COMMUNITY_SERMON_REPLACED_WITH_LOCAL_WORK'
      );

      const reconciled = await coordinator.replacePlanRevision(
        nextEnvelope,
        options,
        {
          expectedRevisionId: localSave.revisionId,
          decisions: [{
            conflictId: replacementConflict.conflictId,
            choice
          }]
        }
      );
      assert.doesNotThrow(() => normalizeServiceProject(reconciled.project));
      const expectedSermonId = choice === 'keep-local'
        ? oldDocument.id
        : nextDocument.id;
      const ownerResourceId =
        reconciled.project.items[ownerId].sermonResourceId;
      assert.equal(
        reconciled.project.resources[ownerResourceId].document.id,
        expectedSermonId
      );
      assert.equal(
        reconciled.project.items[readingId]
          .sermonReading.sermonResourceId,
        ownerResourceId
      );
      assert.ok(reconciled.project.items[cueId]);
      assert.deepEqual(
        reconciled.project.items[cueId].textByChannel,
        projectedCue.textByChannel
      );
      assert.equal(
        reconciled.project.items[cueId].operatorNotes,
        projectedCue.operatorNotes
      );
      if (choice === 'keep-local') {
        assert.ok(
          reconciled.project.items[cueId].sourceBodyProjection
        );
      } else {
        assert.equal(
          resolveSermonSourceLink(
            reconciled.project,
            reconciled.project.items[cueId]
          ).resource.document.id,
          nextDocument.id
        );
        assert.equal(
          reconciled.project.items[cueId].sourceBodyProjection,
          undefined
        );
        assert.equal(
          reconciled.project.resources[previousResourceId],
          undefined
        );
      }
    });
  }
});

test('outer sermon replacement preserves a nested independently linked projection', async t => {
  const canonicalSermon = ({ id, title, prefix }) => ({
    ...sermonDocument({ references: [sermonReference()] }),
    schemaVersion: 3,
    id,
    titles: { en: title },
    body: [{
      id: `${prefix}-body-en`,
      kind: 'manuscript',
      language: 'en',
      sourceId: null,
      sectionId: null,
      text: `${title} English paragraph.`
    }, {
      id: `${prefix}-body-ru`,
      kind: 'manuscript',
      language: 'ru',
      sourceId: null,
      sectionId: null,
      text: `${title} Russian paragraph.`
    }]
  });
  const records = {
    'sync-outer-a': {
      document: canonicalSermon({
        id: 'outer-sermon-a',
        title: 'Outer sermon A',
        prefix: 'outer-a'
      }),
      revision: '6'.repeat(64)
    },
    'sync-outer-b': {
      document: canonicalSermon({
        id: 'outer-sermon-b',
        title: 'Outer sermon B',
        prefix: 'outer-b'
      }),
      revision: '7'.repeat(64)
    }
  };
  const nestedDocument = canonicalSermon({
    id: 'nested-sermon-d',
    title: 'Nested independent sermon D',
    prefix: 'nested-d'
  });
  const nestedRevision = '8'.repeat(64);
  const { coordinator, projectStore, options } = await harness(t, {
    sermonStateProvider(syncId) {
      const record = records[syncId];
      assert.ok(record);
      return {
        syncId,
        localSermonId: record.document.id,
        syncVersion: 1,
        localRevision: record.revision,
        remoteRevision: record.revision,
        conflict: null
      };
    },
    sermonRevisionProvider(sermonId, revision) {
      const record = Object.values(records).find(candidate =>
        candidate.document.id === sermonId
        && candidate.revision === revision);
      assert.ok(record);
      return { sermon: record.document, revision };
    }
  });
  const identityPlan = (syncId, revision) => planV2({
    entries: planV2().entries.map(entry =>
      entry.id === 'sermon'
        ? {
            ...entry,
            syncId,
            expectedRevision: revision,
            expectedSyncVersion: 1
          }
        : entry)
  });
  const first = await coordinator.importPlan(
    envelope(identityPlan(
      'sync-outer-a',
      records['sync-outer-a'].revision
    )),
    options
  );
  const ownerId = managedItemId('sermon');
  const nested = addSermonResource(first.project, nestedDocument, {
    provider: 'local-sermon-library',
    providerId: 'main-sanctuary',
    itemId: nestedDocument.id,
    revision: nestedRevision
  });
  let local = addGroupItem(nested.project, {
    id: 'nested-sermon-d-owner',
    title: 'Nested sermon D owner',
    groupKind: 'sermon',
    sermonResourceId: nested.resourceId,
    parentId: ownerId,
    now: NOW
  });
  const proposal = buildCanonicalSermonBodyProjectionProposal({
    project: local,
    projectRevisionId: serviceProjectRevisionId(local),
    anchorItemId: 'nested-sermon-d-owner',
    sermonId: nestedDocument.id,
    sermonRevisionId: nested.resourceId.slice('sha256:'.length),
    channelMappings: [{
      channelId: 'primary',
      mode: 'body-entry',
      bodyEntryId: 'nested-d-body-en'
    }, {
      channelId: 'secondary',
      mode: 'body-entry',
      bodyEntryId: 'nested-d-body-ru'
    }],
    now: NOW
  });
  const projected = applyCanonicalSermonBodyProjection({
    project: local,
    proposal,
    decisions: {
      rows: [{
        rowId: 'nested-d-projected-cue',
        action: 'insert',
        paragraphIdsByChannel: {
          primary: 'paragraph-001',
          secondary: 'paragraph-001'
        }
      }],
      skippedParagraphIdsByChannel: {
        primary: [],
        secondary: []
      }
    },
    confirmed: true,
    idFactory: ({ rowId }) => rowId,
    placementIndex: 0
  });
  const cueId = projected.insertedItemIds[0];
  const localSave = await projectStore.save(projected.project, {
    expectedRevisionId: first.revisionId,
    reason: 'nested-independent-sermon-projection'
  });
  const nextEnvelope = envelope(identityPlan(
    'sync-outer-b',
    records['sync-outer-b'].revision
  ), { syncVersion: 4 });
  const reviewed = await coordinator.propose(nextEnvelope, options);
  const replacementConflict = reviewed.reconciliation.conflicts.find(
    conflict =>
      conflict.kind === 'COMMUNITY_SERMON_REPLACED_WITH_LOCAL_WORK'
  );
  assert.ok(replacementConflict);

  const reconciled = await coordinator.replacePlanRevision(
    nextEnvelope,
    options,
    {
      expectedRevisionId: localSave.revisionId,
      decisions: reviewed.reconciliation.conflicts.map(conflict => ({
        conflictId: conflict.conflictId,
        choice: conflict.conflictId === replacementConflict.conflictId
          ? 'use-community'
          : 'keep-local'
      }))
    }
  );
  assert.equal(
    reconciled.project.resources[
      reconciled.project.items[ownerId].sermonResourceId
    ].document.id,
    records['sync-outer-b'].document.id
  );
  assert.equal(
    reconciled.project.items['nested-sermon-d-owner'].sermonResourceId,
    nested.resourceId
  );
  assert.ok(reconciled.project.items[cueId].sourceBodyProjection);
  assert.equal(
    resolveSermonSourceLink(
      reconciled.project,
      reconciled.project.items[cueId]
    ).resource.document.id,
    nestedDocument.id
  );
});

test('outer sermon replacement preserves a nested projection sharing the old resource', async t => {
  const canonicalSermon = ({ id, title, prefix }) => ({
    ...sermonDocument({ references: [sermonReference()] }),
    schemaVersion: 3,
    id,
    titles: { en: title },
    body: [{
      id: `${prefix}-body-en`,
      kind: 'manuscript',
      language: 'en',
      sourceId: null,
      sectionId: null,
      text: `${title} English paragraph.`
    }, {
      id: `${prefix}-body-ru`,
      kind: 'manuscript',
      language: 'ru',
      sourceId: null,
      sectionId: null,
      text: `${title} Russian paragraph.`
    }]
  });
  const records = {
    'sync-shared-a': {
      document: canonicalSermon({
        id: 'shared-sermon-a',
        title: 'Shared sermon A',
        prefix: 'shared-a'
      }),
      revision: 'a'.repeat(64)
    },
    'sync-shared-b': {
      document: canonicalSermon({
        id: 'shared-sermon-b',
        title: 'Replacement sermon B',
        prefix: 'shared-b'
      }),
      revision: 'b'.repeat(64)
    }
  };
  const { coordinator, projectStore, options } = await harness(t, {
    sermonStateProvider(syncId) {
      const record = records[syncId];
      assert.ok(record);
      return {
        syncId,
        localSermonId: record.document.id,
        syncVersion: 1,
        localRevision: record.revision,
        remoteRevision: record.revision,
        conflict: null
      };
    },
    sermonRevisionProvider(sermonId, revision) {
      const record = Object.values(records).find(candidate =>
        candidate.document.id === sermonId
        && candidate.revision === revision);
      assert.ok(record);
      return { sermon: record.document, revision };
    }
  });
  const identityPlan = (syncId, revision) => planV2({
    entries: planV2().entries.map(entry =>
      entry.id === 'sermon'
        ? {
            ...entry,
            syncId,
            expectedRevision: revision,
            expectedSyncVersion: 1
          }
        : entry)
  });
  const first = await coordinator.importPlan(
    envelope(identityPlan(
      'sync-shared-a',
      records['sync-shared-a'].revision
    )),
    options
  );
  const ownerId = managedItemId('sermon');
  const previousResourceId =
    first.project.items[ownerId].sermonResourceId;
  const nestedOwnerId = 'nested-shared-sermon-owner';
  let local = addGroupItem(first.project, {
    id: nestedOwnerId,
    title: 'Nested shared sermon owner',
    groupKind: 'sermon',
    sermonResourceId: previousResourceId,
    parentId: ownerId,
    now: NOW
  });
  const projection = buildCanonicalSermonBodyProjectionProposal({
    project: local,
    projectRevisionId: serviceProjectRevisionId(local),
    anchorItemId: nestedOwnerId,
    sermonId: records['sync-shared-a'].document.id,
    sermonRevisionId: previousResourceId.slice('sha256:'.length),
    channelMappings: [{
      channelId: 'primary',
      mode: 'body-entry',
      bodyEntryId: 'shared-a-body-en'
    }, {
      channelId: 'secondary',
      mode: 'body-entry',
      bodyEntryId: 'shared-a-body-ru'
    }],
    now: NOW
  });
  const projected = applyCanonicalSermonBodyProjection({
    project: local,
    proposal: projection,
    decisions: {
      rows: [{
        rowId: 'nested-shared-projected-cue',
        action: 'insert',
        paragraphIdsByChannel: {
          primary: 'paragraph-001',
          secondary: 'paragraph-001'
        }
      }],
      skippedParagraphIdsByChannel: {
        primary: [],
        secondary: []
      }
    },
    confirmed: true,
    idFactory: ({ rowId }) => rowId,
    placementIndex: 0
  });
  const cueId = projected.insertedItemIds[0];
  assert.equal(
    resolveSermonSourceLink(
      projected.project,
      projected.project.items[cueId]
    ).resourceOwnerId,
    nestedOwnerId
  );
  const originalReceipt =
    projected.project.items[cueId].sourceBodyProjection;
  const localSave = await projectStore.save(projected.project, {
    expectedRevisionId: first.revisionId,
    reason: 'nested-shared-sermon-projection'
  });
  const nextEnvelope = envelope(identityPlan(
    'sync-shared-b',
    records['sync-shared-b'].revision
  ), { syncVersion: 4 });
  const reviewed = await coordinator.propose(nextEnvelope, options);
  const replacementConflict = reviewed.reconciliation.conflicts.find(
    conflict =>
      conflict.kind === 'COMMUNITY_SERMON_REPLACED_WITH_LOCAL_WORK'
  );
  assert.ok(replacementConflict);

  const reconciled = await coordinator.replacePlanRevision(
    nextEnvelope,
    options,
    {
      expectedRevisionId: localSave.revisionId,
      decisions: reviewed.reconciliation.conflicts.map(conflict => ({
        conflictId: conflict.conflictId,
        choice: conflict.conflictId === replacementConflict.conflictId
          ? 'use-community'
          : 'keep-local'
      }))
    }
  );
  assert.notEqual(
    reconciled.project.items[ownerId].sermonResourceId,
    previousResourceId
  );
  assert.equal(
    reconciled.project.items[nestedOwnerId].sermonResourceId,
    previousResourceId
  );
  assert.deepEqual(
    reconciled.project.items[cueId].sourceBodyProjection,
    originalReceipt
  );
  const resolvedNested = resolveSermonSourceLink(
    reconciled.project,
    reconciled.project.items[cueId]
  );
  assert.equal(resolvedNested.resourceOwnerId, nestedOwnerId);
  assert.equal(
    resolvedNested.resource.document.id,
    records['sync-shared-a'].document.id
  );
});

test('linked reading existence follows one same-sermon or replacement choice without hybrids', async t => {
  const oldRevision = '1'.repeat(64);
  const nextRevision = '2'.repeat(64);
  const readingEntry = planV2().entries.find(entry =>
    entry.id === 'reading');
  const transitions = [{
    label: 'same sermon',
    conflictKind: 'COMMUNITY_SERMON_PIN_CHANGED_WITH_LOCAL_WORK',
    oldDocument: {
      ...sermonDocument({ references: [sermonReference()] }),
      id: 'atomic-same-sermon',
      titles: { en: 'Same sermon, first revision' }
    },
    nextDocument: {
      ...sermonDocument({ references: [sermonReference()] }),
      id: 'atomic-same-sermon',
      titles: { en: 'Same sermon, next revision' }
    }
  }, {
    label: 'different sermon',
    conflictKind: 'COMMUNITY_SERMON_REPLACED_WITH_LOCAL_WORK',
    oldDocument: {
      ...sermonDocument({ references: [sermonReference()] }),
      id: 'atomic-old-sermon',
      titles: { en: 'Original sermon identity' }
    },
    nextDocument: {
      ...sermonDocument({ references: [sermonReference()] }),
      id: 'atomic-next-sermon',
      titles: { en: 'Replacement sermon identity' }
    }
  }];

  for (const transition of transitions) {
    for (const operation of ['Community deletes', 'Community adds']) {
      for (const choice of ['keep-local', 'use-community']) {
        await t.test(
          `${transition.label}: ${operation}: ${choice}`,
          async subtest => {
            const records = {
              'sync-atomic-old': {
                document: transition.oldDocument,
                revision: oldRevision
              },
              'sync-atomic-next': {
                document: transition.nextDocument,
                revision: nextRevision
              }
            };
            const { coordinator, projectStore, options } =
              await harness(subtest, {
                sermonStateProvider(syncId) {
                  const record = records[syncId];
                  assert.ok(record, `unexpected sermon sync ${syncId}`);
                  return {
                    syncId,
                    localSermonId: record.document.id,
                    syncVersion: 1,
                    localRevision: record.revision,
                    remoteRevision: record.revision,
                    conflict: null
                  };
                },
                sermonRevisionProvider(sermonId, revision) {
                  const record = Object.values(records).find(candidate =>
                    candidate.document.id === sermonId
                    && candidate.revision === revision);
                  assert.ok(record, `missing sermon ${sermonId}:${revision}`);
                  return { sermon: record.document, revision };
                }
              });
            const includesReadingInitially =
              operation === 'Community deletes';
            const transitionPlan = ({
              syncId,
              revision,
              includeReading
            }) => planV2({
              entries: [{
                id: 'opening',
                kind: 'section',
                title: 'Opening'
              }, ...(includeReading ? [readingEntry] : []), {
                id: 'sermon',
                kind: 'sermon',
                title: 'Sermon',
                syncId,
                expectedRevision: revision,
                expectedSyncVersion: 1
              }]
            });
            const initialPlan = transitionPlan({
              syncId: 'sync-atomic-old',
              revision: oldRevision,
              includeReading: includesReadingInitially
            });
            const first = await coordinator.importPlan(
              envelope(initialPlan),
              options
            );
            const ownerId = managedItemId('sermon');
            const readingId = managedItemId('reading');
            const previousResourceId =
              first.project.items[ownerId].sermonResourceId;
            const withLocalCue = addGroupItem(first.project, {
              id: 'local-atomic-sermon-cue',
              title: 'Local sermon cue',
              groupKind: 'custom',
              parentId: ownerId,
              now: NOW
            });
            const localSave = await projectStore.save(withLocalCue, {
              expectedRevisionId: first.revisionId,
              reason: `atomic-reading-${operation}-${choice}`
            });
            const nextEnvelope = envelope(transitionPlan({
              syncId: 'sync-atomic-next',
              revision: nextRevision,
              includeReading: !includesReadingInitially
            }), { syncVersion: 4 });
            const reviewed = await coordinator.propose(
              nextEnvelope,
              options
            );
            assert.equal(
              reviewed.reconciliation.conflictCount,
              1,
              JSON.stringify(reviewed.reconciliation.conflicts, null, 2)
            );
            const [sharedConflict] =
              reviewed.reconciliation.conflicts;
            assert.equal(sharedConflict.kind, transition.conflictKind);

            const reconciled = await coordinator.replacePlanRevision(
              nextEnvelope,
              options,
              {
                expectedRevisionId: localSave.revisionId,
                decisions: [{
                  conflictId: sharedConflict.conflictId,
                  choice
                }]
              }
            );
            const ownerResourceId =
              reconciled.project.items[ownerId].sermonResourceId;
            const expectedReading =
              choice === 'keep-local'
                ? includesReadingInitially
                : !includesReadingInitially;
            assert.equal(
              Boolean(reconciled.project.items[readingId]),
              expectedReading
            );
            assert.equal(
              ownerResourceId === previousResourceId,
              choice === 'keep-local'
            );
            if (expectedReading) {
              assert.equal(
                reconciled.project.items[readingId]
                  .sermonReading.sermonResourceId,
                ownerResourceId
              );
            }
            assert.ok(
              reconciled.project.items['local-atomic-sermon-cue']
            );
            assert.doesNotThrow(
              () => normalizeServiceProject(reconciled.project)
            );
          }
        );
      }
    }
  }
});

test('a locally deleted linked reading restores only with its shared sermon choice', async t => {
  for (const replacement of [false, true]) {
    for (const choice of ['keep-local', 'use-community']) {
      await t.test(
        `${replacement ? 'different' : 'same'} sermon: ${choice}`,
        async subtest => {
          const oldRevision = '3'.repeat(64);
          const nextRevision = '4'.repeat(64);
          const oldDocument = {
            ...sermonDocument({ references: [sermonReference()] }),
            id: replacement
              ? 'deleted-reading-old-sermon'
              : 'deleted-reading-same-sermon'
          };
          const nextDocument = {
            ...sermonDocument({ references: [sermonReference()] }),
            id: replacement
              ? 'deleted-reading-next-sermon'
              : oldDocument.id,
            titles: { en: 'Community sermon revision' }
          };
          const records = {
            old: { document: oldDocument, revision: oldRevision },
            next: { document: nextDocument, revision: nextRevision }
          };
          const { coordinator, projectStore, options } =
            await harness(subtest, {
              sermonStateProvider(syncId) {
                const record = records[syncId];
                return {
                  syncId,
                  localSermonId: record.document.id,
                  syncVersion: 1,
                  localRevision: record.revision,
                  remoteRevision: record.revision,
                  conflict: null
                };
              },
              sermonRevisionProvider(sermonId, revision) {
                const record = Object.values(records).find(candidate =>
                  candidate.document.id === sermonId
                  && candidate.revision === revision);
                assert.ok(record);
                return { sermon: record.document, revision };
              }
            });
          const linkedPlan = (syncId, revision) => planV2({
            entries: planV2().entries.map(entry =>
              entry.id === 'sermon'
                ? {
                    ...entry,
                    syncId,
                    expectedRevision: revision,
                    expectedSyncVersion: 1
                  }
                : entry)
          });
          const first = await coordinator.importPlan(
            envelope(linkedPlan('old', oldRevision)),
            options
          );
          const ownerId = managedItemId('sermon');
          const readingId = managedItemId('reading');
          const previousResourceId =
            first.project.items[ownerId].sermonResourceId;
          const deleted = removeProjectItemAndDescendants(
            first.project,
            readingId
          );
          const localSave = await projectStore.save(deleted, {
            expectedRevisionId: first.revisionId,
            reason: `delete-linked-reading-${replacement}-${choice}`
          });
          const nextEnvelope = envelope(
            linkedPlan('next', nextRevision),
            { syncVersion: 4 }
          );
          const reviewed = await coordinator.propose(nextEnvelope, options);
          assert.equal(reviewed.reconciliation.conflictCount, 1);
          const [sharedConflict] = reviewed.reconciliation.conflicts;
          assert.equal(
            sharedConflict.kind,
            replacement
              ? 'COMMUNITY_SERMON_REPLACED_WITH_LOCAL_WORK'
              : 'COMMUNITY_SERMON_PIN_CHANGED_WITH_LOCAL_WORK'
          );

          const reconciled = await coordinator.replacePlanRevision(
            nextEnvelope,
            options,
            {
              expectedRevisionId: localSave.revisionId,
              decisions: [{
                conflictId: sharedConflict.conflictId,
                choice
              }]
            }
          );
          assert.equal(
            Boolean(reconciled.project.items[readingId]),
            choice === 'use-community'
          );
          assert.equal(
            reconciled.project.items[ownerId].sermonResourceId
              === previousResourceId,
            choice === 'keep-local'
          );
          if (choice === 'use-community') {
            assert.equal(
              reconciled.project.items[readingId]
                .sermonReading.sermonResourceId,
              reconciled.project.items[ownerId].sermonResourceId
            );
          }
        }
      );
    }
  }
});

test('linked reading kind changes remain part of the shared sermon choice', async t => {
  for (const source of ['Community', 'local']) {
    for (const choice of ['keep-local', 'use-community']) {
      await t.test(`${source} kind change: ${choice}`, async subtest => {
        const nextRevision = '5'.repeat(64);
        const sermonState = {};
        let currentRevision = SERMON_REVISION;
        let currentDocument = sermonDocument({
          references: [sermonReference()]
        });
        const { coordinator, projectStore, options } =
          await harness(subtest, {
            sermonState,
            sermonRevisionProvider(sermonId, revision) {
              assert.equal(sermonId, currentDocument.id);
              assert.equal(revision, currentRevision);
              return { sermon: currentDocument, revision };
            }
          });
        const first = await coordinator.importPlan(
          envelope(planV2()),
          options
        );
        const ownerId = managedItemId('sermon');
        const readingId = managedItemId('reading');
        const openingId = managedItemId('opening');
        const previousResourceId =
          first.project.items[ownerId].sermonResourceId;
        let local = first.project;
        if (source === 'Community') {
          local = addGroupItem(local, {
            id: 'local-kind-change-sermon-cue',
            title: 'Local sermon cue',
            groupKind: 'custom',
            parentId: ownerId,
            now: NOW
          });
        } else {
          local = removeProjectItemAndDescendants(local, readingId);
          local = addProjectItem(local, {
            id: readingId,
            kind: 'notice',
            title: 'Local notice in reading slot',
            textByChannel: Object.fromEntries(
              local.channelIds.map(channelId => [
                channelId,
                'Local notice'
              ])
            ),
            presetId: 'notice-text',
            operatorNotes: ''
          }, {
            parentId: openingId,
            now: NOW
          });
          local = moveProjectItem(local, {
            itemId: readingId,
            targetParentId: openingId,
            targetIndex: 1
          });
        }
        const localSave = await projectStore.save(local, {
          expectedRevisionId: first.revisionId,
          reason: `linked-reading-kind-${source}-${choice}`
        });
        currentRevision = nextRevision;
        currentDocument = {
          ...currentDocument,
          titles: { en: 'Community sermon revision' }
        };
        Object.assign(sermonState, {
          syncVersion: 5,
          localRevision: nextRevision,
          remoteRevision: nextRevision
        });
        const nextEntries = planV2().entries.map(entry => {
          if (entry.id === 'reading' && source === 'Community') {
            return {
              ...plan().entries.find(candidate =>
                candidate.kind === 'song'),
              id: 'reading',
              title: 'Community song in reading slot'
            };
          }
          if (entry.id === 'sermon') {
            return {
              ...entry,
              expectedRevision: nextRevision,
              expectedSyncVersion: 5
            };
          }
          return entry;
        });
        const nextEnvelope = envelope(
          planV2({ entries: nextEntries }),
          { syncVersion: 5 }
        );
        const reviewed = await coordinator.propose(nextEnvelope, options);
        assert.equal(
          reviewed.reconciliation.conflictCount,
          1,
          JSON.stringify(reviewed.reconciliation.conflicts, null, 2)
        );
        const [sharedConflict] = reviewed.reconciliation.conflicts;
        assert.equal(
          sharedConflict.kind,
          'COMMUNITY_SERMON_PIN_CHANGED_WITH_LOCAL_WORK'
        );

        const reconciled = await coordinator.replacePlanRevision(
          nextEnvelope,
          options,
          {
            expectedRevisionId: localSave.revisionId,
            decisions: [{
              conflictId: sharedConflict.conflictId,
              choice
            }]
          }
        );
        assert.equal(
          reconciled.project.items[ownerId].sermonResourceId
            === previousResourceId,
          choice === 'keep-local'
        );
        const expectedKind = source === 'Community'
          ? (choice === 'keep-local' ? 'bible' : 'song')
          : (choice === 'keep-local' ? 'notice' : 'bible');
        assert.equal(reconciled.project.items[readingId].kind, expectedKind);
        if (expectedKind === 'bible') {
          assert.equal(
            reconciled.project.items[readingId]
              .sermonReading.sermonResourceId,
            reconciled.project.items[ownerId].sermonResourceId
          );
        }
      });
    }
  }
});

test('matching local and Community semantic changes converge without false conflicts', async t => {
  await t.test('song pin preserves local arrangement and presentation', async subtest => {
    const songState = {};
    const mutable = mutableSongCatalog();
    const { coordinator, projectStore, options } =
      await harness(subtest, {
        songState,
        songSnapshotProvider: () => mutable.snapshotProvider(),
        songRevisionProvider: (songId, revision) =>
          mutable.revisionProvider(songId, revision)
      });
    const first = await coordinator.importPlan(envelope(), options);
    const songId = managedItemId('song-grace');
    const songItem = first.project.items[songId];
    const nextRootRevision = '6'.repeat(64);
    const nextRussianRevision = '7'.repeat(64);
    const nextRecordRevision = 'song:song-family-grace:8';
    mutable.catalog.rootSong = songDocument({
      line: 'Locally and remotely converged root lyrics'
    });
    mutable.catalog.rootRevision = nextRootRevision;
    mutable.catalog.russianSong = songDocument({
      id: 'grace-alone-ru',
      title: 'Только благодать',
      language: 'ru',
      translationOf: 'grace-alone',
      line: 'Locally and remotely converged Russian lyrics'
    });
    mutable.catalog.russianRevision = nextRussianRevision;
    mutable.catalog.familyRevision = '8'.repeat(64);
    Object.assign(songState, {
      syncVersion: 8,
      remoteRevision: nextRecordRevision,
      documents: {
        'grace-alone': {
          localRevision: nextRootRevision,
          remoteRevision: nextRootRevision
        },
        'grace-alone-ru': {
          localRevision: nextRussianRevision,
          remoteRevision: nextRussianRevision
        }
      }
    });
    const rootPinned = addSongResource(
      first.project,
      mutable.catalog.rootSong,
      {
        provider: 'local-song-library',
        providerId: 'grace-alone',
        itemId: mutable.catalog.rootSong.id,
        revision: nextRootRevision
      }
    );
    const russianPinned = addSongResource(
      rootPinned.project,
      mutable.catalog.russianSong,
      {
        provider: 'local-song-library',
        providerId: 'grace-alone',
        itemId: mutable.catalog.russianSong.id,
        revision: nextRussianRevision
      }
    );
    const localRaw = JSON.parse(
      require('../src/services/project')
        .serializeServiceProject(russianPinned.project)
    );
    localRaw.items[songId].variants.primary = {
      ...localRaw.items[songId].variants.primary,
      mode: 'content',
      resourceId: rootPinned.resourceId
    };
    localRaw.items[songId].variants.secondary = {
      ...localRaw.items[songId].variants.secondary,
      mode: 'content',
      resourceId: russianPinned.resourceId
    };
    localRaw.items[songId].arrangement =
      [...songItem.arrangement].reverse();
    localRaw.items[songId].operatorNotes =
      'Preserve converged local song treatment.';
    const local = normalizeServiceProject(localRaw);
    const localSave = await projectStore.save(local, {
      expectedRevisionId: first.revisionId,
      reason: 'locally-converged-song-pin'
    });
    const nextEnvelope = envelope(plan({
      entries: plan().entries.map(entry =>
        entry.id === 'song-grace'
          ? {
              ...entry,
              expectedRevision: nextRecordRevision,
              expectedSyncVersion: 8
            }
          : entry)
    }), { syncVersion: 4 });
    const reviewed = await coordinator.propose(nextEnvelope, options);
    assert.equal(
      reviewed.reconciliation.conflictCount,
      0,
      JSON.stringify(reviewed.reconciliation.conflicts, null, 2)
    );

    const reconciled = await coordinator.replacePlanRevision(
      nextEnvelope,
      options,
      {
        expectedRevisionId: localSave.revisionId,
        decisions: []
      }
    );
    assert.deepEqual(
      reconciled.project.items[songId].arrangement,
      local.items[songId].arrangement
    );
    assert.equal(
      reconciled.project.items[songId].operatorNotes,
      'Preserve converged local song treatment.'
    );
    assert.equal(
      reconciled.project.items[songId]
        .variants.primary.resourceId,
      rootPinned.resourceId
    );
  });

  await t.test('Scripture spec preserves the local passage snapshot', async subtest => {
    const nextRange = {
      schemaVersion: 1,
      bookId: 'Eph',
      start: { chapter: 3, verse: 14 },
      end: { chapter: 3, verse: 14 }
    };
    const { coordinator, projectStore, options } =
      await harness(subtest, {
        biblePassageProvider({ call }) {
          if (call === 1) return biblePassage();
          return {
            ...biblePassage(),
            verseEnd: 14,
            reference: 'Ephesians 3:14',
            verses: [{
              number: 14,
              text: 'Community resolver snapshot.'
            }]
          };
        }
      });
    const first = await coordinator.importPlan(envelope(), options);
    const openingId = managedItemId('opening');
    const readingId = managedItemId('reading');
    const withSnapshot = addBibleItem(first.project, {
      id: 'local-converged-reading-fixture',
      title: 'Local converged reading fixture',
      range: nextRange,
      passagesByChannel: Object.fromEntries(
        first.project.channelIds.map(channelId => [
          channelId,
          {
            ...biblePassage(),
            verseEnd: 14,
            reference: 'Ephesians 3:14',
            verses: [{
              number: 14,
              text: 'Preserved local resolver snapshot.'
            }]
          }
        ])
      ),
      parentId: openingId,
      now: NOW
    });
    const localRaw = JSON.parse(
      require('../src/services/project')
        .serializeServiceProject(withSnapshot)
    );
    localRaw.items[readingId].range = nextRange;
    localRaw.items[readingId].passagesByChannel =
      localRaw.items['local-converged-reading-fixture']
        .passagesByChannel;
    localRaw.items[readingId].operatorNotes =
      'Preserve local Scripture treatment.';
    localRaw.items[openingId].childIds =
      localRaw.items[openingId].childIds.filter(
        itemId => itemId !== 'local-converged-reading-fixture'
      );
    delete localRaw.items['local-converged-reading-fixture'];
    const local = normalizeServiceProject(localRaw);
    const localSave = await projectStore.save(local, {
      expectedRevisionId: first.revisionId,
      reason: 'locally-converged-scripture-spec'
    });
    const nextEnvelope = envelope(plan({
      entries: plan().entries.map(entry =>
        entry.id === 'reading'
          ? {
              ...entry,
              title: 'Ephesians 3:14',
              range: nextRange
            }
          : entry)
    }), { syncVersion: 4 });
    const reviewed = await coordinator.propose(nextEnvelope, options);
    assert.equal(reviewed.reconciliation.conflictCount, 0);

    const reconciled = await coordinator.replacePlanRevision(
      nextEnvelope,
      options,
      {
        expectedRevisionId: localSave.revisionId,
        decisions: []
      }
    );
    assert.equal(
      reconciled.project.items[readingId]
        .passagesByChannel.primary.verses[0].text,
      'Preserved local resolver snapshot.'
    );
    assert.equal(
      reconciled.project.items[readingId].operatorNotes,
      'Preserve local Scripture treatment.'
    );
    assert.deepEqual(
      reconciled.project.items[readingId].range,
      {
        bookId: 'Eph',
        start: { chapter: 3, verse: 14 },
        end: { chapter: 3, verse: 14 }
      }
    );
  });

  await t.test('sermon group spec preserves compatible local work', async subtest => {
    const sermonState = {};
    let currentRevision = SERMON_REVISION;
    let currentDocument = sermonDocument();
    const { coordinator, projectStore, options } =
      await harness(subtest, {
        sermonState,
        sermonRevisionProvider(sermonId, revision) {
          assert.equal(sermonId, currentDocument.id);
          assert.equal(revision, currentRevision);
          return { sermon: currentDocument, revision };
        }
      });
    const first = await coordinator.importPlan(envelope(), options);
    const ownerId = managedItemId('sermon');
    currentRevision = 'a'.repeat(64);
    currentDocument = {
      ...currentDocument,
      titles: { en: 'Converged sermon revision' }
    };
    Object.assign(sermonState, {
      syncVersion: 5,
      localRevision: currentRevision,
      remoteRevision: currentRevision
    });
    const pinned = addSermonResource(first.project, currentDocument, {
      provider: 'local-sermon-library',
      providerId: 'wotbc-community',
      itemId: currentDocument.id,
      revision: currentRevision
    });
    let local = setSermonSourceLink(pinned.project, {
      itemId: ownerId,
      sermonResourceId: pinned.resourceId,
      now: NOW
    });
    local = updateGroupItem(local, {
      itemId: ownerId,
      operatorNotes: 'Preserve local sermon-group treatment.',
      now: NOW
    });
    local = addGroupItem(local, {
      id: 'local-converged-sermon-cue',
      title: 'Compatible local sermon cue',
      groupKind: 'custom',
      parentId: ownerId,
      now: NOW
    });
    const localSave = await projectStore.save(local, {
      expectedRevisionId: first.revisionId,
      reason: 'locally-converged-sermon-group-spec'
    });
    const nextEnvelope = envelope(plan({
      entries: plan().entries.map(entry =>
        entry.id === 'sermon'
          ? {
              ...entry,
              expectedRevision: currentRevision,
              expectedSyncVersion: 5
            }
          : entry)
    }), { syncVersion: 5 });
    const reviewed = await coordinator.propose(nextEnvelope, options);
    assert.equal(reviewed.reconciliation.conflictCount, 0);

    const reconciled = await coordinator.replacePlanRevision(
      nextEnvelope,
      options,
      {
        expectedRevisionId: localSave.revisionId,
        decisions: []
      }
    );
    assert.equal(
      reconciled.project.items[ownerId].sermonResourceId,
      pinned.resourceId
    );
    assert.equal(
      reconciled.project.items[ownerId].operatorNotes,
      'Preserve local sermon-group treatment.'
    );
    assert.ok(
      reconciled.project.items['local-converged-sermon-cue']
    );
  });
});

test('Keep Local preserves changed metadata on a same-ID reachable resource', async t => {
  const { coordinator, projectStore, options } = await harness(t);
  const first = await coordinator.importPlan(envelope(), options);
  const songId = managedItemId('song-grace');
  const resourceId =
    first.project.items[songId].variants.primary.resourceId;
  const localRaw = JSON.parse(
    require('../src/services/project')
      .serializeServiceProject(first.project)
  );
  localRaw.items[songId].title = 'Locally titled song cue';
  localRaw.resources[resourceId].origin = {
    provider: 'local-curated-library',
    providerId: 'main-sanctuary',
    itemId: 'grace-alone-curated',
    revision: 'operator-reviewed-origin-1'
  };
  const local = normalizeServiceProject(localRaw);
  const localSave = await projectStore.save(local, {
    expectedRevisionId: first.revisionId,
    reason: 'same-id-local-resource-metadata'
  });
  const nextEnvelope = envelope(plan({
    entries: plan().entries.map(entry =>
      entry.id === 'song-grace'
        ? { ...entry, title: 'Community titled song cue' }
        : entry)
  }), { syncVersion: 4 });
  const reviewed = await coordinator.propose(nextEnvelope, options);
  const songConflict = reviewed.reconciliation.conflicts.find(conflict =>
    conflict.itemId === songId);
  assert.ok(songConflict);

  const reconciled = await coordinator.replacePlanRevision(
    nextEnvelope,
    options,
    {
      expectedRevisionId: localSave.revisionId,
      decisions: reviewed.reconciliation.conflicts.map(conflict => ({
        conflictId: conflict.conflictId,
        choice: conflict.conflictId === songConflict.conflictId
          ? 'keep-local'
          : 'use-community'
      }))
    }
  );
  assert.equal(
    reconciled.project.items[songId].variants.primary.resourceId,
    resourceId
  );
  assert.deepEqual(
    reconciled.project.resources[resourceId].origin,
    local.resources[resourceId].origin
  );
  assert.equal(
    reconciled.project.resources[resourceId].origin.provider,
    'local-curated-library'
  );
});

test('Keep Local preserves attribution on a same-ID reachable asset', async t => {
  const entries = [{
    id: 'asset-section',
    kind: 'section',
    title: 'Asset section'
  }];
  const { coordinator, options } = await harness(t);
  const first = await coordinator.importPlan(
    envelope(plan({ entries })),
    options
  );
  const sectionId = managedItemId('asset-section');
  const assetSha256 = '9'.repeat(64);
  const assetId = `sha256:${assetSha256}`;
  const imageAsset = attribution => ({
    id: assetId,
    kind: 'image',
    sha256: assetSha256,
    fileName: 'same-image.png',
    storedName: `${assetSha256}.png`,
    mediaType: 'image/png',
    size: 4096,
    createdAt: NOW,
    attribution,
    altText: 'Same content-addressed image',
    width: 1920,
    height: 1080,
    orientation: 1
  });
  const addAssetRecord = (project, attribution) => {
    const raw = JSON.parse(
      require('../src/services/project').serializeServiceProject(project)
    );
    raw.assets[assetId] = imageAsset(attribution);
    return normalizeServiceProject(raw);
  };
  let local = addAssetRecord(
    first.project,
    'Locally reviewed image attribution'
  );
  local = addProjectItem(local, {
    id: 'local-same-id-picture',
    kind: 'picture',
    title: 'Local retained picture',
    assetId,
    channelIds: [...local.channelIds],
    fit: 'fit',
    focalPoint: { x: 0.5, y: 0.5 },
    altText: 'Same content-addressed image',
    attribution: 'Locally reviewed image attribution',
    presetId: 'picture-fullscreen',
    operatorNotes: ''
  }, {
    parentId: sectionId,
    now: NOW
  });
  local = updateGroupItem(local, {
    itemId: sectionId,
    title: 'Local asset section',
    now: NOW
  });

  let community = addAssetRecord(
    first.project,
    'Community image attribution'
  );
  community = updateGroupItem(community, {
    itemId: sectionId,
    title: 'Community asset section',
    now: NOW
  });
  const communityRaw = JSON.parse(
    require('../src/services/project').serializeServiceProject(community)
  );
  communityRaw.planning.schemaVersion = 2;
  communityRaw.planning.source.planRevision = '8'.repeat(64);
  delete communityRaw.planning.reconciliationBaseline;
  community = normalizeServiceProject(communityRaw);
  const communityBaseline = communityServicePlanBaselineFromProject(
    community,
    entries.map(entry => ({
      ...entry,
      title: 'Community asset section'
    }))
  );
  community = bindCommunityServicePlanBaseline(
    community,
    communityBaseline
  );
  const proposal = buildCommunityServicePlanReconciliation({
    baseline: first.project.planning.reconciliationBaseline,
    localProject: local,
    communityProject: community,
    communityBaseline
  });
  const titleConflict = proposal.conflicts.find(conflict =>
    conflict.itemId === sectionId);
  assert.ok(titleConflict);
  const reconciled = buildCommunityServicePlanReconciliation({
    baseline: first.project.planning.reconciliationBaseline,
    localProject: local,
    communityProject: community,
    communityBaseline,
    decisions: proposal.conflicts.map(conflict => ({
      conflictId: conflict.conflictId,
      choice: conflict.conflictId === titleConflict.conflictId
        ? 'keep-local'
        : 'use-community'
    })),
    requireDecisions: true
  });
  assert.ok(reconciled.project.items['local-same-id-picture']);
  assert.equal(
    reconciled.project.assets[assetId].attribution,
    'Locally reviewed image attribution'
  );
});

test('local leaf deletion versus a Community placement-only move is explicit', async t => {
  for (const choice of ['keep-local', 'use-community']) {
    await t.test(choice, async subtest => {
      const songEntry = {
        ...plan().entries.find(entry => entry.kind === 'song'),
        id: 'movable-leaf',
        title: 'Movable leaf'
      };
      const initialPlan = plan({
        entries: [{
          id: 'section-a',
          kind: 'section',
          title: 'Section A'
        }, songEntry, {
          id: 'section-b',
          kind: 'section',
          title: 'Section B'
        }]
      });
      const { coordinator, projectStore, options } =
        await harness(subtest);
      const first = await coordinator.importPlan(
        envelope(initialPlan),
        options
      );
      const leafId = managedItemId('movable-leaf');
      const sectionBId = managedItemId('section-b');
      const deleted = removeProjectItemAndDescendants(
        first.project,
        leafId
      );
      const localSave = await projectStore.save(deleted, {
        expectedRevisionId: first.revisionId,
        reason: `deleted-leaf-before-community-move-${choice}`
      });
      const nextEnvelope = envelope(plan({
        entries: [{
          id: 'section-a',
          kind: 'section',
          title: 'Section A'
        }, {
          id: 'section-b',
          kind: 'section',
          title: 'Section B'
        }, songEntry]
      }), { syncVersion: 4 });
      const reviewed = await coordinator.propose(nextEnvelope, options);
      assert.equal(reviewed.reconciliation.conflictCount, 1);
      const [deletionConflict] = reviewed.reconciliation.conflicts;
      assert.equal(
        deletionConflict.kind,
        'LOCAL_ITEM_DELETED_AFTER_COMMUNITY_CHANGE'
      );
      assert.equal(deletionConflict.itemId, leafId);

      const reconciled = await coordinator.replacePlanRevision(
        nextEnvelope,
        options,
        {
          expectedRevisionId: localSave.revisionId,
          decisions: [{
            conflictId: deletionConflict.conflictId,
            choice
          }]
        }
      );
      if (choice === 'keep-local') {
        assert.equal(reconciled.project.items[leafId], undefined);
      } else {
        assert.equal(
          projectItemParentId(reconciled.project, leafId),
          sectionBId
        );
      }
      assert.equal(reconciled.project.rootItemIds.includes(leafId), false);
    });
  }
});

test('a partially deleted group never lifts its locally moved survivor to root', async t => {
  for (const choice of ['keep-local', 'use-community']) {
    await t.test(choice, async subtest => {
      const childEntry = {
        ...plan().entries.find(entry => entry.kind === 'song'),
        id: 'surviving-child',
        title: 'Surviving child'
      };
      const initialPlan = plan({
        entries: [{
          id: 'deleted-group',
          kind: 'section',
          title: 'Deleted group'
        }, childEntry, {
          id: 'surviving-group',
          kind: 'section',
          title: 'Surviving group'
        }]
      });
      const { coordinator, projectStore, options } =
        await harness(subtest);
      const first = await coordinator.importPlan(
        envelope(initialPlan),
        options
      );
      const deletedGroupId = managedItemId('deleted-group');
      const survivingGroupId = managedItemId('surviving-group');
      const childId = managedItemId('surviving-child');
      let local = moveProjectItem(first.project, {
        itemId: childId,
        targetParentId: survivingGroupId,
        targetIndex: 0
      });
      local = removeProjectItemAndDescendants(local, deletedGroupId);
      const localSave = await projectStore.save(local, {
        expectedRevisionId: first.revisionId,
        reason: `partial-group-deletion-${choice}`
      });
      const nextEnvelope = envelope(plan({
        entries: [{
          id: 'surviving-group',
          kind: 'section',
          title: 'Surviving group'
        }, {
          id: 'deleted-group',
          kind: 'section',
          title: 'Deleted group'
        }, childEntry]
      }), { syncVersion: 4 });
      const reviewed = await coordinator.propose(nextEnvelope, options);
      const groupConflict = reviewed.reconciliation.conflicts.find(
        conflict =>
          conflict.itemId === deletedGroupId
          && conflict.kind ===
            'LOCAL_ITEM_DELETED_AFTER_COMMUNITY_CHANGE'
      );
      assert.ok(
        groupConflict,
        JSON.stringify(reviewed.reconciliation.conflicts, null, 2)
      );

      const reconciled = await coordinator.replacePlanRevision(
        nextEnvelope,
        options,
        {
          expectedRevisionId: localSave.revisionId,
          decisions: reviewed.reconciliation.conflicts.map(conflict => ({
            conflictId: conflict.conflictId,
            choice: conflict.conflictId === groupConflict.conflictId
              ? choice
              : 'keep-local'
          }))
        }
      );
      assert.equal(
        Boolean(reconciled.project.items[deletedGroupId]),
        choice === 'use-community'
      );
      assert.ok(reconciled.project.items[childId]);
      assert.equal(
        projectItemParentId(reconciled.project, childId),
        survivingGroupId
      );
      assert.equal(reconciled.project.rootItemIds.includes(childId), false);
    });
  }
});

test('restoring a changed deleted group atomically restores its moved child', async t => {
  const parentEntry = {
    ...plan().entries.find(entry => entry.kind === 'sermon'),
    id: 'restored-parent',
    title: 'Restored parent'
  };
  const childEntry = {
    ...plan().entries.find(entry => entry.kind === 'song'),
    id: 'restored-child',
    title: 'Restored child'
  };
  const entries = [{
    id: 'outer-parent',
    kind: 'section',
    title: 'Outer parent'
  }, parentEntry, childEntry];
  const { coordinator, options } = await harness(t);
  const first = await coordinator.importPlan(
    envelope(plan({ entries })),
    options
  );
  const outerId = managedItemId('outer-parent');
  const parentId = managedItemId('restored-parent');
  const childId = managedItemId('restored-child');
  assert.equal(projectItemParentId(first.project, parentId), outerId);
  assert.equal(projectItemParentId(first.project, childId), outerId);
  const local = removeProjectItemAndDescendants(
    first.project,
    parentId
  );
  assert.equal(projectItemParentId(local, childId), outerId);

  let community = updateGroupItem(first.project, {
    itemId: parentId,
    title: 'Community changed restored parent',
    now: NOW
  });
  community = moveProjectItem(community, {
    itemId: childId,
    targetParentId: parentId,
    targetIndex: 0
  });
  const communityRaw = JSON.parse(
    require('../src/services/project').serializeServiceProject(community)
  );
  communityRaw.planning.schemaVersion = 2;
  communityRaw.planning.source.planRevision = '7'.repeat(64);
  delete communityRaw.planning.reconciliationBaseline;
  community = normalizeServiceProject(communityRaw);
  const communityEntries = entries.map(entry =>
    entry.id === parentEntry.id
      ? { ...entry, title: 'Community changed restored parent' }
      : entry);
  const communityBaseline = communityServicePlanBaselineFromProject(
    community,
    communityEntries
  );
  community = bindCommunityServicePlanBaseline(
    community,
    communityBaseline
  );
  const proposal = buildCommunityServicePlanReconciliation({
    baseline: first.project.planning.reconciliationBaseline,
    localProject: local,
    communityProject: community,
    communityBaseline
  });
  assert.equal(
    proposal.conflictCount,
    1,
    JSON.stringify(proposal.conflicts, null, 2)
  );
  const [parentConflict] = proposal.conflicts;
  assert.equal(parentConflict.itemId, parentId);
  assert.equal(
    parentConflict.kind,
    'LOCAL_ITEM_DELETED_AFTER_COMMUNITY_CHANGE'
  );

  for (const choice of ['keep-local', 'use-community']) {
    const reconciled = buildCommunityServicePlanReconciliation({
      baseline: first.project.planning.reconciliationBaseline,
      localProject: local,
      communityProject: community,
      communityBaseline,
      decisions: [{
        conflictId: parentConflict.conflictId,
        choice
      }],
      requireDecisions: true
    });
    assert.doesNotThrow(() => normalizeServiceProject(reconciled.project));
    if (choice === 'keep-local') {
      assert.equal(reconciled.project.items[parentId], undefined);
      assert.equal(
        projectItemParentId(reconciled.project, childId),
        outerId
      );
    } else {
      assert.equal(
        reconciled.project.items[parentId].title,
        'Community changed restored parent'
      );
      assert.equal(
        projectItemParentId(reconciled.project, childId),
        parentId
      );
      assert.deepEqual(
        reconciled.project.items[parentId].childIds,
        [childId]
      );
    }
  }
});

test('a connected structure choice discloses that Community restores a deleted section', async t => {
  const entries = ['p', 'h', 'a', 'c'].map(id => ({
    id: `disclosure-${id}`,
    kind: 'section',
    title: `Disclosure ${id.toUpperCase()}`
  }));
  const { coordinator, options } = await harness(t);
  const first = await coordinator.importPlan(
    envelope(plan({ entries })),
    options
  );
  const parentId = managedItemId('disclosure-p');
  const hingeId = managedItemId('disclosure-h');
  const anchorId = managedItemId('disclosure-a');
  const childId = managedItemId('disclosure-c');
  let baselineProject = moveProjectItem(first.project, {
    itemId: childId,
    targetParentId: anchorId,
    targetIndex: 0
  });
  baselineProject = bindCommunityServicePlanBaseline(
    baselineProject,
    communityServicePlanBaselineFromProject(baselineProject, entries)
  );

  let local = moveProjectItem(baselineProject, {
    itemId: hingeId,
    targetParentId: childId,
    targetIndex: 0
  });
  local = removeProjectItemAndDescendants(local, parentId);

  let community = moveProjectItem(baselineProject, {
    itemId: parentId,
    targetParentId: hingeId,
    targetIndex: 0
  });
  community = moveProjectItem(community, {
    itemId: childId,
    targetParentId: parentId,
    targetIndex: 0
  });
  const communityRaw = JSON.parse(
    require('../src/services/project').serializeServiceProject(community)
  );
  communityRaw.planning.schemaVersion = 2;
  communityRaw.planning.source.planRevision = '6'.repeat(64);
  delete communityRaw.planning.reconciliationBaseline;
  community = normalizeServiceProject(communityRaw);
  const communityBaseline = communityServicePlanBaselineFromProject(
    community,
    entries
  );
  community = bindCommunityServicePlanBaseline(
    community,
    communityBaseline
  );

  const proposal = buildCommunityServicePlanReconciliation({
    baseline: baselineProject.planning.reconciliationBaseline,
    localProject: local,
    communityProject: community,
    communityBaseline
  });
  assert.equal(
    proposal.conflictCount,
    1,
    JSON.stringify(proposal.conflicts, null, 2)
  );
  const [structureConflict] = proposal.conflicts;
  assert.equal(
    structureConflict.title,
    'Connected section moves and restoration'
  );
  assert.match(
    structureConflict.local.summary,
    /keep the locally deleted section absent.*Disclosure P/i
  );
  assert.match(
    structureConflict.community.summary,
    /restore the reviewed section and subtrees.*Disclosure P/i
  );

  for (const choice of ['keep-local', 'use-community']) {
    const reconciled = buildCommunityServicePlanReconciliation({
      baseline: baselineProject.planning.reconciliationBaseline,
      localProject: local,
      communityProject: community,
      communityBaseline,
      decisions: [{
        conflictId: structureConflict.conflictId,
        choice
      }],
      requireDecisions: true
    });
    assert.doesNotThrow(() => normalizeServiceProject(reconciled.project));
    if (choice === 'keep-local') {
      assert.equal(reconciled.project.items[parentId], undefined);
      assert.equal(projectItemParentId(reconciled.project, childId), anchorId);
      assert.equal(projectItemParentId(reconciled.project, hingeId), childId);
    } else {
      assert.equal(projectItemParentId(reconciled.project, parentId), hingeId);
      assert.equal(projectItemParentId(reconciled.project, childId), parentId);
      assert.equal(projectItemParentId(reconciled.project, hingeId), null);
    }
  }
});

test('a stable-ID group collision selects one complete subtree without hybrids', async t => {
  const initialEntries = [{
    id: 'collision-anchor',
    kind: 'section',
    title: 'Collision anchor'
  }];
  const songEntry = plan().entries.find(entry => entry.kind === 'song');
  const nextEntries = [...initialEntries, {
    id: 'collision-group',
    kind: 'section',
    title: 'Community collision group'
  }, {
    ...songEntry,
    id: 'collision-shared-two',
    title: 'Community shared child two'
  }, {
    ...songEntry,
    id: 'collision-shared-one',
    title: 'Community shared child one'
  }, {
    ...songEntry,
    id: 'collision-remote-child',
    title: 'Community-only collision child'
  }];
  const laterRemoteChildEntry = {
    ...songEntry,
    id: 'collision-later-remote-child',
    title: 'Later Community-only collision child'
  };
  for (const choice of ['keep-local', 'use-community']) {
    await t.test(choice, async subtest => {
      const { coordinator, projectStore, options } =
        await harness(subtest);
      const first = await coordinator.importPlan(
        envelope(plan({ entries: initialEntries })),
        options
      );
      const anchorId = managedItemId('collision-anchor');
      const collisionGroupId = managedItemId('collision-group');
      const remoteChildId = managedItemId('collision-remote-child');
      const laterRemoteChildId =
        managedItemId('collision-later-remote-child');
      const sharedOneId = managedItemId('collision-shared-one');
      const sharedTwoId = managedItemId('collision-shared-two');
      const localChildId = 'local-collision-child';
      let local = addGroupItem(first.project, {
        id: collisionGroupId,
        title: 'Locally created collision group',
        groupKind: 'custom',
        parentId: null,
        now: NOW
      });
      local = addProjectItem(local, {
        id: localChildId,
        kind: 'notice',
        title: 'Local collision child',
        textByChannel: Object.fromEntries(
          local.channelIds.map(channelId => [
            channelId,
            'Local child must remain local.'
          ])
        ),
        presetId: 'notice-text',
        operatorNotes: ''
      }, {
        parentId: collisionGroupId,
        now: NOW
      });
      for (const [id, title] of [
        [sharedOneId, 'Local shared child one'],
        [sharedTwoId, 'Local shared child two']
      ]) {
        local = addProjectItem(local, {
          id,
          kind: 'notice',
          title,
          textByChannel: Object.fromEntries(
            local.channelIds.map(channelId => [
              channelId,
              `${title} must follow the selected subtree.`
            ])
          ),
          presetId: 'notice-text',
          operatorNotes: ''
        }, {
          parentId: collisionGroupId,
          now: NOW
        });
      }
      local = moveProjectItem(local, {
        itemId: collisionGroupId,
        targetParentId: null,
        targetIndex: 0
      });
      const localSave = await projectStore.save(local, {
        expectedRevisionId: first.revisionId,
        reason: 'local-stable-id-group-collision'
      });
      const nextEnvelope = envelope(
        plan({ entries: nextEntries }),
        { syncVersion: 4 }
      );
      const reviewed = await coordinator.propose(nextEnvelope, options);
      assert.equal(
        reviewed.reconciliation.conflictCount,
        1,
        JSON.stringify(reviewed.reconciliation.conflicts, null, 2)
      );
      const [collisionConflict] = reviewed.reconciliation.conflicts;
      assert.equal(collisionConflict.kind, 'LOCAL_ITEM_ID_COLLISION');
      assert.match(
        collisionConflict.local.summary,
        /complete.*local.*subtree/i
      );
      assert.match(
        collisionConflict.community.summary,
        /complete.*Community.*subtree/i
      );

      const reconciled = await coordinator.replacePlanRevision(
        nextEnvelope,
        options,
        {
          expectedRevisionId: localSave.revisionId,
          decisions: [{
            conflictId: collisionConflict.conflictId,
            choice
          }]
        }
      );
      assert.doesNotThrow(() => normalizeServiceProject(reconciled.project));
      if (choice === 'keep-local') {
        assert.equal(
          reconciled.project.items[collisionGroupId].title,
          'Locally created collision group'
        );
        assert.deepEqual(
          reconciled.project.rootItemIds,
          [collisionGroupId, anchorId]
        );
        assert.deepEqual(
          reconciled.project.items[collisionGroupId].childIds,
          [localChildId, sharedOneId, sharedTwoId]
        );
        assert.ok(reconciled.project.items[localChildId]);
        assert.equal(reconciled.project.items[remoteChildId], undefined);
        assert.equal(
          reconciled.project.items[sharedOneId].title,
          'Local shared child one'
        );
        assert.equal(
          reconciled.project.items[sharedTwoId].title,
          'Local shared child two'
        );
        assert.deepEqual(
          reconciled.project.planning.localCollisionBoundaryItemIds,
          [collisionGroupId]
        );

        const laterEnvelope = envelope(
          plan({ entries: [...nextEntries, laterRemoteChildEntry] }),
          { syncVersion: 5 }
        );
        const laterReviewed =
          await coordinator.propose(laterEnvelope, options);
        assert.equal(
          laterReviewed.reconciliation.conflictCount,
          1,
          JSON.stringify(
            laterReviewed.reconciliation.conflicts,
            null,
            2
          )
        );
        const [laterCollisionConflict] =
          laterReviewed.reconciliation.conflicts;
        assert.equal(
          laterCollisionConflict.kind,
          'LOCAL_ITEM_ID_COLLISION'
        );
        const retainedAgain =
          await coordinator.replacePlanRevision(
            laterEnvelope,
            options,
            {
              expectedRevisionId: reconciled.revisionId,
              decisions: [{
                conflictId: laterCollisionConflict.conflictId,
                choice: 'keep-local'
              }]
            }
          );
        assert.deepEqual(
          retainedAgain.project.items[collisionGroupId].childIds,
          [localChildId, sharedOneId, sharedTwoId]
        );
        assert.equal(
          retainedAgain.project.items[remoteChildId],
          undefined
        );
        assert.equal(
          retainedAgain.project.items[laterRemoteChildId],
          undefined
        );
        assert.deepEqual(
          retainedAgain.project.planning
            .localCollisionBoundaryItemIds,
          [collisionGroupId]
        );
      } else {
        assert.equal(
          reconciled.project.items[collisionGroupId].title,
          'Community collision group'
        );
        assert.deepEqual(
          reconciled.project.rootItemIds,
          [anchorId, collisionGroupId]
        );
        assert.deepEqual(
          reconciled.project.items[collisionGroupId].childIds,
          [sharedTwoId, sharedOneId, remoteChildId]
        );
        assert.equal(reconciled.project.items[localChildId], undefined);
        assert.ok(reconciled.project.items[remoteChildId]);
        assert.equal(
          reconciled.project.items[sharedOneId].title,
          'Community shared child one'
        );
        assert.equal(
          reconciled.project.items[sharedTwoId].title,
          'Community shared child two'
        );
        assert.equal(
          reconciled.project.planning.localCollisionBoundaryItemIds,
          undefined
        );
      }
    });
  }
});

test('a cycle-coupled stable-ID collision still discloses whole-subtree replacement', async t => {
  const initialEntries = [{
    id: 'collision-cycle-anchor',
    kind: 'section',
    title: 'Collision cycle anchor'
  }];
  const { coordinator, options } = await harness(t);
  const first = await coordinator.importPlan(
    envelope(plan({ entries: initialEntries })),
    options
  );
  const anchorId = managedItemId('collision-cycle-anchor');
  const rootId = managedItemId('collision-cycle-root');
  const groupAId = managedItemId('collision-cycle-a');
  const groupBId = managedItemId('collision-cycle-b');
  const remoteOnlyId = managedItemId('collision-cycle-remote-only');
  const localOnlyId = 'local-collision-cycle-only';

  let local = addGroupItem(first.project, {
    id: rootId,
    title: 'Local collision cycle root',
    groupKind: 'custom',
    parentId: null,
    now: NOW
  });
  local = addGroupItem(local, {
    id: groupAId,
    title: 'Local collision cycle A',
    groupKind: 'custom',
    parentId: rootId,
    now: NOW
  });
  local = addGroupItem(local, {
    id: groupBId,
    title: 'Local collision cycle B',
    groupKind: 'custom',
    parentId: groupAId,
    now: NOW
  });
  local = addGroupItem(local, {
    id: localOnlyId,
    title: 'Local-only collision descendant',
    groupKind: 'custom',
    parentId: rootId,
    now: NOW
  });
  local = moveProjectItem(local, {
    itemId: rootId,
    targetParentId: null,
    targetIndex: 0
  });

  let community = addGroupItem(first.project, {
    id: rootId,
    title: 'Community collision cycle root',
    groupKind: 'section',
    parentId: null,
    now: NOW
  });
  community = addGroupItem(community, {
    id: groupBId,
    title: 'Community collision cycle B',
    groupKind: 'section',
    parentId: rootId,
    now: NOW
  });
  community = addGroupItem(community, {
    id: groupAId,
    title: 'Community collision cycle A',
    groupKind: 'section',
    parentId: groupBId,
    now: NOW
  });
  community = addGroupItem(community, {
    id: remoteOnlyId,
    title: 'Community-only collision descendant',
    groupKind: 'section',
    parentId: rootId,
    now: NOW
  });
  const communityRaw = JSON.parse(
    require('../src/services/project').serializeServiceProject(community)
  );
  communityRaw.planning.schemaVersion = 2;
  communityRaw.planning.source.planRevision = '6'.repeat(64);
  delete communityRaw.planning.reconciliationBaseline;
  delete communityRaw.planning.lastReconciliationReceipt;
  delete communityRaw.planning.localCollisionBoundaryItemIds;
  community = normalizeServiceProject(communityRaw);
  const communityEntries = [...initialEntries, {
    id: 'collision-cycle-root',
    kind: 'section',
    title: 'Community collision cycle root'
  }, {
    id: 'collision-cycle-b',
    kind: 'section',
    title: 'Community collision cycle B'
  }, {
    id: 'collision-cycle-a',
    kind: 'section',
    title: 'Community collision cycle A'
  }, {
    id: 'collision-cycle-remote-only',
    kind: 'section',
    title: 'Community-only collision descendant'
  }];
  const communityBaseline = communityServicePlanBaselineFromProject(
    community,
    communityEntries
  );
  community = bindCommunityServicePlanBaseline(
    community,
    communityBaseline
  );

  const proposal = buildCommunityServicePlanReconciliation({
    baseline: first.project.planning.reconciliationBaseline,
    localProject: local,
    communityProject: community,
    communityBaseline
  });
  assert.equal(proposal.conflictCount, 1);
  const [collisionConflict] = proposal.conflicts;
  assert.equal(
    collisionConflict.kind,
    'LOCAL_AND_COMMUNITY_STRUCTURE_CHANGED'
  );
  assert.match(collisionConflict.title, /collision subtree.*moves/i);
  assert.match(
    collisionConflict.local.summary,
    /complete local collision subtree/i
  );
  assert.match(collisionConflict.local.summary, /content/i);
  assert.match(collisionConflict.local.summary, /local-only descendants/i);
  assert.match(collisionConflict.local.summary, /parent structure/i);
  assert.match(collisionConflict.local.summary, /sibling placement/i);
  assert.match(
    collisionConflict.community.summary,
    /complete Community collision subtree/i
  );
  assert.match(collisionConflict.community.summary, /content/i);
  assert.match(
    collisionConflict.community.summary,
    /Community-only descendants/i
  );
  assert.match(collisionConflict.community.summary, /parent structure/i);
  assert.match(collisionConflict.community.summary, /sibling placement/i);

  for (const choice of ['keep-local', 'use-community']) {
    const reconciled = buildCommunityServicePlanReconciliation({
      baseline: first.project.planning.reconciliationBaseline,
      localProject: local,
      communityProject: community,
      communityBaseline,
      decisions: [{
        conflictId: collisionConflict.conflictId,
        choice
      }],
      requireDecisions: true
    });
    assert.doesNotThrow(() => normalizeServiceProject(reconciled.project));
    if (choice === 'keep-local') {
      assert.deepEqual(
        reconciled.project.rootItemIds,
        [rootId, anchorId]
      );
      assert.deepEqual(
        reconciled.project.items[rootId].childIds,
        [groupAId, localOnlyId]
      );
      assert.deepEqual(
        reconciled.project.items[groupAId].childIds,
        [groupBId]
      );
      assert.equal(
        reconciled.project.items[rootId].title,
        'Local collision cycle root'
      );
      assert.ok(reconciled.project.items[localOnlyId]);
      assert.equal(reconciled.project.items[remoteOnlyId], undefined);
      assert.deepEqual(
        reconciled.project.planning.localCollisionBoundaryItemIds,
        [rootId]
      );
    } else {
      assert.deepEqual(
        reconciled.project.rootItemIds,
        [anchorId, rootId]
      );
      assert.deepEqual(
        reconciled.project.items[rootId].childIds,
        [groupBId, remoteOnlyId]
      );
      assert.deepEqual(
        reconciled.project.items[groupBId].childIds,
        [groupAId]
      );
      assert.equal(
        reconciled.project.items[rootId].title,
        'Community collision cycle root'
      );
      assert.equal(reconciled.project.items[localOnlyId], undefined);
      assert.ok(reconciled.project.items[remoteOnlyId]);
      assert.equal(
        reconciled.project.planning.localCollisionBoundaryItemIds,
        undefined
      );
    }
  }
});

test('stable-ID group collisions fail closed when subtree boundaries disagree', async t => {
  const songEntry = plan().entries.find(entry => entry.kind === 'song');

  await t.test(
    'nested local collision roots cannot become separate Community roots',
    async subtest => {
      const { coordinator, projectStore, options } =
        await harness(subtest);
      const initialEntries = [{
        id: 'anchor',
        kind: 'section',
        title: 'Anchor'
      }];
      const first = await coordinator.importPlan(
        envelope(plan({ entries: initialEntries })),
        options
      );
      const xId = managedItemId('x');
      const zId = managedItemId('z');
      let local = addGroupItem(first.project, {
        id: xId,
        title: 'Local X',
        groupKind: 'custom',
        parentId: null,
        now: NOW
      });
      local = addGroupItem(local, {
        id: zId,
        title: 'Local Z',
        groupKind: 'custom',
        parentId: xId,
        now: NOW
      });
      await projectStore.save(local, {
        expectedRevisionId: first.revisionId,
        reason: 'local-nested-stable-id-collisions'
      });

      const reviewed = await coordinator.propose(
        envelope(plan({
          entries: [...initialEntries, {
            id: 'x',
            kind: 'section',
            title: 'Community X'
          }, {
            ...songEntry,
            id: 'remote-x-child',
            title: 'Community X child'
          }, {
            id: 'z',
            kind: 'section',
            title: 'Community Z'
          }, {
            ...songEntry,
            id: 'remote-z-child',
            title: 'Community Z child'
          }]
        }), { syncVersion: 4 }),
        options
      );

      assert.equal(
        reviewed.status,
        'blocked',
        JSON.stringify(reviewed, null, 2)
      );
      assert.deepEqual(
        reviewed.blockers.map(blocker => blocker.code),
        ['COMMUNITY_PLAN_RECONCILIATION_STRUCTURE_OVERLAP']
      );
      assert.equal(
        (await projectStore.read(first.projectId)).project.items[zId].title,
        'Local Z'
      );
    }
  );

  await t.test(
    'a managed item cannot disappear when only one subtree contains it',
    async subtest => {
      const { coordinator, projectStore, options } =
        await harness(subtest);
      const initialEntries = [{
        id: 'anchor',
        kind: 'section',
        title: 'Anchor'
      }, {
        id: 'existing',
        kind: 'section',
        title: 'Existing section'
      }];
      const first = await coordinator.importPlan(
        envelope(plan({ entries: initialEntries })),
        options
      );
      const xId = managedItemId('x');
      const existingId = managedItemId('existing');
      let local = addGroupItem(first.project, {
        id: xId,
        title: 'Local X',
        groupKind: 'custom',
        parentId: null,
        now: NOW
      });
      local = moveProjectItem(local, {
        itemId: existingId,
        targetParentId: xId,
        targetIndex: 0
      });
      await projectStore.save(local, {
        expectedRevisionId: first.revisionId,
        reason: 'local-cross-boundary-stable-id-collision'
      });

      const reviewed = await coordinator.propose(
        envelope(plan({
          entries: [...initialEntries, {
            id: 'x',
            kind: 'section',
            title: 'Community X'
          }, {
            ...songEntry,
            id: 'remote-x-child',
            title: 'Community X child'
          }]
        }), { syncVersion: 4 }),
        options
      );

      assert.equal(
        reviewed.status,
        'blocked',
        JSON.stringify(reviewed, null, 2)
      );
      assert.deepEqual(
        reviewed.blockers.map(blocker => blocker.code),
        ['COMMUNITY_PLAN_RECONCILIATION_STRUCTURE_OVERLAP']
      );
      assert.ok(
        (await projectStore.read(first.projectId)).project.items[existingId]
      );
    }
  );
});

test('a stable-ID collision cannot escape a locally deleted Community subtree', async t => {
  const initialEntries = [{
    id: 'kept',
    kind: 'section',
    title: 'Kept section'
  }, {
    id: 'deleted',
    kind: 'section',
    title: 'Locally deleted section'
  }];
  const { coordinator, projectStore, options } = await harness(t);
  const first = await coordinator.importPlan(
    envelope(plan({ entries: initialEntries })),
    options
  );
  const keptId = managedItemId('kept');
  const deletedId = managedItemId('deleted');
  const collisionId = managedItemId('new-remote-child');
  let local = removeProjectItemAndDescendants(first.project, deletedId);
  local = addProjectItem(local, {
    id: collisionId,
    kind: 'notice',
    title: 'Local child with colliding identity',
    textByChannel: Object.fromEntries(
      local.channelIds.map(channelId => [
        channelId,
        'This local item must not be lifted or replaced.'
      ])
    ),
    presetId: 'notice-text',
    operatorNotes: ''
  }, {
    parentId: keptId,
    now: NOW
  });
  const localSave = await projectStore.save(local, {
    expectedRevisionId: first.revisionId,
    reason: 'local-deleted-parent-stable-id-collision'
  });
  const songEntry = plan().entries.find(entry => entry.kind === 'song');
  const reviewed = await coordinator.propose(
    envelope(plan({
      entries: [...initialEntries, {
        ...songEntry,
        id: 'new-remote-child',
        title: 'Community child under deleted section'
      }]
    }), { syncVersion: 4 }),
    options
  );

  assert.equal(
    reviewed.status,
    'blocked',
    JSON.stringify(reviewed, null, 2)
  );
  assert.deepEqual(
    reviewed.blockers.map(blocker => blocker.code),
    ['COMMUNITY_PLAN_RECONCILIATION_STRUCTURE_OVERLAP']
  );
  const unchanged = await projectStore.read(first.projectId);
  assert.equal(unchanged.revisionId, localSave.revisionId);
  assert.equal(
    projectItemParentId(unchanged.project, collisionId),
    keptId
  );
});

test('a stable-ID group collision cannot be bypassed by an atomic sermon repin', async t => {
  const primaryReference = sermonReference({
    startVerse: 14,
    endVerse: 15
  });
  const sermonState = {};
  let currentSermonRevision = SERMON_REVISION;
  let currentSermon = sermonDocument({
    references: [primaryReference]
  });
  const { coordinator, projectStore, options } = await harness(t, {
    sermonState,
    sermonRevisionProvider(sermonId, revision) {
      assert.equal(sermonId, currentSermon.id);
      assert.equal(revision, currentSermonRevision);
      return { sermon: currentSermon, revision };
    }
  });
  const first = await coordinator.importPlan(
    envelope(planV2()),
    options
  );
  const collisionId = managedItemId('sermon-collision-section');
  const sermonGroup = Object.values(first.project.items).find(item =>
    item.kind === 'group' && item.groupKind === 'sermon');
  const previousResourceId = sermonGroup.sermonResourceId;
  let local = addGroupItem(first.project, {
    id: collisionId,
    title: 'Local sermon collision section',
    groupKind: 'custom',
    parentId: null,
    now: NOW
  });
  local = moveProjectItem(local, {
    itemId: sermonGroup.id,
    targetParentId: collisionId,
    targetIndex: 0
  });
  const localSave = await projectStore.save(local, {
    expectedRevisionId: first.revisionId,
    reason: 'local-sermon-stable-id-collision'
  });

  currentSermonRevision = '9'.repeat(64);
  currentSermon = {
    ...currentSermon,
    titles: { en: 'Community sermon revision in collision' }
  };
  Object.assign(sermonState, {
    syncVersion: 5,
    localRevision: currentSermonRevision,
    remoteRevision: currentSermonRevision
  });
  const nextEntries = planV2().entries.flatMap(entry =>
    entry.id === 'sermon'
      ? [{
          id: 'sermon-collision-section',
          kind: 'section',
          title: 'Community sermon collision section'
        }, {
          ...entry,
          expectedRevision: currentSermonRevision,
          expectedSyncVersion: 5
        }]
      : [entry]);
  const reviewed = await coordinator.propose(
    envelope(planV2({ entries: nextEntries }), { syncVersion: 5 }),
    options
  );

  assert.equal(
    reviewed.status,
    'blocked',
    JSON.stringify(reviewed, null, 2)
  );
  assert.deepEqual(
    reviewed.blockers.map(blocker => blocker.code),
    ['COMMUNITY_PLAN_RECONCILIATION_STRUCTURE_OVERLAP']
  );
  const unchanged = await projectStore.read(first.projectId);
  assert.equal(unchanged.revisionId, localSave.revisionId);
  assert.equal(
    unchanged.project.items[sermonGroup.id].sermonResourceId,
    previousResourceId
  );
});

test('a new linked-reading collision follows its sermon choice and exact order', async t => {
  const primaryReference = sermonReference({
    startVerse: 14,
    endVerse: 15
  });
  const sermonState = {};
  let currentSermonRevision = SERMON_REVISION;
  let currentSermon = sermonDocument({
    references: [primaryReference]
  });
  const { coordinator, projectStore, options } = await harness(t, {
    sermonState,
    sermonRevisionProvider(sermonId, revision) {
      assert.equal(sermonId, currentSermon.id);
      assert.equal(revision, currentSermonRevision);
      return { sermon: currentSermon, revision };
    }
  });
  const initialPlan = planV2();
  const first = await coordinator.importPlan(
    envelope(initialPlan),
    options
  );
  const openingId = managedItemId('opening');
  const songId = managedItemId('song-grace');
  const oldReadingId = managedItemId('reading');
  const collisionReadingId = managedItemId('collision-reading');
  const sermonId = managedItemId('sermon');
  let local = addProjectItem(first.project, {
    id: collisionReadingId,
    kind: 'notice',
    title: 'Local reading-ID collision',
    textByChannel: Object.fromEntries(
      first.project.channelIds.map(channelId => [
        channelId,
        'Local notice using the future reading identity.'
      ])
    ),
    presetId: 'notice-text',
    operatorNotes: ''
  }, {
    parentId: openingId,
    now: NOW
  });
  local = moveProjectItem(local, {
    itemId: collisionReadingId,
    targetParentId: openingId,
    targetIndex: 0
  });
  const localSave = await projectStore.save(local, {
    expectedRevisionId: first.revisionId,
    reason: 'local-linked-reading-stable-id-collision'
  });

  currentSermonRevision = '9'.repeat(64);
  currentSermon = {
    ...currentSermon,
    titles: { en: 'Community sermon with replacement reading' }
  };
  Object.assign(sermonState, {
    syncVersion: 5,
    localRevision: currentSermonRevision,
    remoteRevision: currentSermonRevision
  });
  const oldReadingEntry =
    initialPlan.entries.find(entry => entry.id === 'reading');
  const nextEntries = initialPlan.entries.flatMap(entry => {
    if (entry.id === 'reading') return [];
    if (entry.id === 'sermon') {
      return [{
        ...oldReadingEntry,
        id: 'collision-reading',
        title: 'Community replacement reading'
      }, {
        ...entry,
        expectedRevision: currentSermonRevision,
        expectedSyncVersion: 5
      }];
    }
    return [entry];
  });
  const nextEnvelope = envelope(
    planV2({ entries: nextEntries }),
    { syncVersion: 5 }
  );
  const reviewed = await coordinator.propose(nextEnvelope, options);
  assert.equal(
    reviewed.reconciliation.conflictCount,
    1,
    JSON.stringify(reviewed.reconciliation.conflicts, null, 2)
  );
  const [sermonConflict] = reviewed.reconciliation.conflicts;
  assert.equal(
    sermonConflict.kind,
    'COMMUNITY_SERMON_PIN_CHANGED_WITH_LOCAL_WORK'
  );

  const reconciled = await coordinator.replacePlanRevision(
    nextEnvelope,
    options,
    {
      expectedRevisionId: localSave.revisionId,
      decisions: [{
        conflictId: sermonConflict.conflictId,
        choice: 'use-community'
      }]
    }
  );
  assert.equal(
    reconciled.project.items[collisionReadingId].kind,
    'bible'
  );
  assert.equal(reconciled.project.items[oldReadingId], undefined);
  assert.deepEqual(
    reconciled.project.items[openingId].childIds,
    [songId, collisionReadingId, sermonId]
  );
});

test('a stable-ID leaf collision binds its exact sibling position', async t => {
  const songEntry = plan().entries.find(entry => entry.kind === 'song');
  const initialEntries = [{
    id: 'leaf-collision-section',
    kind: 'section',
    title: 'Collision section'
  }, {
    ...songEntry,
    id: 'leaf-anchor-one',
    title: 'Anchor one'
  }, {
    ...songEntry,
    id: 'leaf-anchor-two',
    title: 'Anchor two'
  }];
  const nextEntries = [...initialEntries, {
    ...songEntry,
    id: 'leaf-collision',
    title: 'Community collision leaf'
  }];

  for (const choice of ['keep-local', 'use-community']) {
    await t.test(choice, async subtest => {
      const { coordinator, projectStore, options } =
        await harness(subtest);
      const first = await coordinator.importPlan(
        envelope(plan({ entries: initialEntries })),
        options
      );
      const sectionId = managedItemId('leaf-collision-section');
      const anchorOneId = managedItemId('leaf-anchor-one');
      const anchorTwoId = managedItemId('leaf-anchor-two');
      const collisionId = managedItemId('leaf-collision');
      let local = addProjectItem(first.project, {
        id: collisionId,
        kind: 'notice',
        title: 'Local collision leaf',
        textByChannel: Object.fromEntries(
          first.project.channelIds.map(channelId => [
            channelId,
            'Local collision leaf.'
          ])
        ),
        presetId: 'notice-text',
        operatorNotes: ''
      }, {
        parentId: sectionId,
        index: 0,
        now: NOW
      });
      local = moveProjectItem(local, {
        itemId: collisionId,
        targetParentId: sectionId,
        targetIndex: 0
      });
      const localSave = await projectStore.save(local, {
        expectedRevisionId: first.revisionId,
        reason: 'local-stable-id-leaf-collision'
      });
      const nextEnvelope = envelope(
        plan({ entries: nextEntries }),
        { syncVersion: 4 }
      );
      const reviewed = await coordinator.propose(nextEnvelope, options);
      assert.equal(reviewed.reconciliation.conflictCount, 1);
      const [collisionConflict] = reviewed.reconciliation.conflicts;
      assert.equal(collisionConflict.kind, 'LOCAL_ITEM_ID_COLLISION');

      const reconciled = await coordinator.replacePlanRevision(
        nextEnvelope,
        options,
        {
          expectedRevisionId: localSave.revisionId,
          decisions: [{
            conflictId: collisionConflict.conflictId,
            choice
          }]
        }
      );
      assert.deepEqual(
        reconciled.project.items[sectionId].childIds,
        choice === 'keep-local'
          ? [collisionId, anchorOneId, anchorTwoId]
          : [anchorOneId, anchorTwoId, collisionId]
      );
      assert.equal(
        reconciled.project.items[collisionId].title,
        choice === 'keep-local'
          ? 'Local collision leaf'
          : 'Community collision leaf'
      );
    });
  }
});

test('group-to-leaf plus child Keep Local uses the final lifted parent', async t => {
  const songEntry = {
    ...plan().entries.find(entry => entry.kind === 'song'),
    id: 'placement-child',
    title: 'Placement child'
  };
  const initialPlan = plan({
    entries: [{
      id: 'kind-parent',
      kind: 'section',
      title: 'Kind parent'
    }, {
      id: 'base-parent',
      kind: 'section',
      title: 'Base parent'
    }, songEntry, {
      id: 'community-parent',
      kind: 'section',
      title: 'Community parent'
    }]
  });
  const { coordinator, projectStore, options } = await harness(t);
  const first = await coordinator.importPlan(
    envelope(initialPlan),
    options
  );
  const kindParentId = managedItemId('kind-parent');
  const childId = managedItemId('placement-child');
  const local = moveProjectItem(first.project, {
    itemId: childId,
    targetParentId: kindParentId,
    targetIndex: 0
  });
  const localSave = await projectStore.save(local, {
    expectedRevisionId: first.revisionId,
    reason: 'child-moved-into-future-leaf'
  });
  const scriptureEntry = {
    ...plan().entries.find(entry => entry.kind === 'scripture'),
    id: 'kind-parent',
    title: 'Kind parent now Scripture'
  };
  const nextEnvelope = envelope(plan({
    entries: [scriptureEntry, {
      id: 'community-parent',
      kind: 'section',
      title: 'Community parent'
    }, songEntry, {
      id: 'base-parent',
      kind: 'section',
      title: 'Base parent'
    }]
  }), { syncVersion: 4 });
  const reviewed = await coordinator.propose(nextEnvelope, options);
  const kindConflict = reviewed.reconciliation.conflicts.find(conflict =>
    conflict.itemId === kindParentId
    && conflict.kind === 'COMMUNITY_ENTRY_KIND_CHANGED_AFTER_LOCAL_CHANGE');
  const childConflict = reviewed.reconciliation.conflicts.find(conflict =>
    conflict.itemId === childId
    && conflict.kind === 'LOCAL_AND_COMMUNITY_STRUCTURE_CHANGED');
  assert.ok(kindConflict);
  assert.ok(childConflict);

  const reconciled = await coordinator.replacePlanRevision(
    nextEnvelope,
    options,
    {
      expectedRevisionId: localSave.revisionId,
      decisions: reviewed.reconciliation.conflicts.map(conflict => ({
        conflictId: conflict.conflictId,
        choice: conflict.conflictId === kindConflict.conflictId
          ? 'use-community'
          : 'keep-local'
      }))
    }
  );
  assert.equal(reconciled.project.items[kindParentId].kind, 'bible');
  assert.equal(projectItemParentId(reconciled.project, childId), null);
  assert.ok(reconciled.project.rootItemIds.includes(childId));
  assert.doesNotThrow(() => normalizeServiceProject(reconciled.project));
});

test('cycle-prone placement choices collapse into one connected structure choice', async t => {
  const entries = ['a', 'b', 'c'].map(id => ({
    id: `group-${id}`,
    kind: 'section',
    title: `Group ${id.toUpperCase()}`
  }));
  const { coordinator, options } = await harness(t);
  const first = await coordinator.importPlan(
    envelope(plan({ entries })),
    options
  );
  const groupAId = managedItemId('group-a');
  const groupBId = managedItemId('group-b');
  const groupCId = managedItemId('group-c');
  let local = moveProjectItem(first.project, {
    itemId: groupAId,
    targetParentId: groupCId,
    targetIndex: 0
  });
  local = moveProjectItem(local, {
    itemId: groupBId,
    targetParentId: groupAId,
    targetIndex: 0
  });
  let community = moveProjectItem(first.project, {
    itemId: groupAId,
    targetParentId: groupBId,
    targetIndex: 0
  });
  community = moveProjectItem(community, {
    itemId: groupBId,
    targetParentId: groupCId,
    targetIndex: 0
  });
  const communityRaw = JSON.parse(
    require('../src/services/project').serializeServiceProject(community)
  );
  communityRaw.planning.schemaVersion = 2;
  communityRaw.planning.source.planRevision = 'f'.repeat(64);
  delete communityRaw.planning.reconciliationBaseline;
  community = normalizeServiceProject(communityRaw);
  const communityBaseline = communityServicePlanBaselineFromProject(
    community,
    entries
  );
  community = bindCommunityServicePlanBaseline(
    community,
    communityBaseline
  );
  const proposal = buildCommunityServicePlanReconciliation({
    baseline: first.project.planning.reconciliationBaseline,
    localProject: local,
    communityProject: community,
    communityBaseline
  });
  assert.equal(proposal.conflictCount, 1);
  const [structureConflict] = proposal.conflicts;
  assert.equal(
    structureConflict.kind,
    'LOCAL_AND_COMMUNITY_STRUCTURE_CHANGED'
  );

  for (const choice of ['keep-local', 'use-community']) {
    const reconciled = buildCommunityServicePlanReconciliation({
      baseline: first.project.planning.reconciliationBaseline,
      localProject: local,
      communityProject: community,
      communityBaseline,
      decisions: [{
        conflictId: structureConflict.conflictId,
        choice
      }],
      requireDecisions: true
    });
    assert.doesNotThrow(() => normalizeServiceProject(reconciled.project));
    if (choice === 'keep-local') {
      assert.equal(
        projectItemParentId(reconciled.project, groupAId),
        groupCId
      );
      assert.equal(
        projectItemParentId(reconciled.project, groupBId),
        groupAId
      );
    } else {
      assert.equal(
        projectItemParentId(reconciled.project, groupAId),
        groupBId
      );
      assert.equal(
        projectItemParentId(reconciled.project, groupBId),
        groupCId
      );
    }
    assert.equal(
      projectItemParentId(reconciled.project, groupCId),
      null
    );
  }
});

test('independent parent moves that compose a cycle become one valid whole-structure choice', async t => {
  for (const choice of ['keep-local', 'use-community']) {
    await t.test(choice, async subtest => {
      const sermonEntry = {
        ...plan().entries.find(entry => entry.kind === 'sermon'),
        id: 'group-b',
        title: 'Group B'
      };
      const initialPlan = plan({
        entries: [{
          id: 'group-a',
          kind: 'section',
          title: 'Group A'
        }, {
          id: 'group-c',
          kind: 'section',
          title: 'Group C'
        }, sermonEntry]
      });
      const { coordinator, projectStore, options } =
        await harness(subtest);
      const first = await coordinator.importPlan(
        envelope(initialPlan),
        options
      );
      const groupAId = managedItemId('group-a');
      const groupBId = managedItemId('group-b');
      const groupCId = managedItemId('group-c');
      assert.equal(projectItemParentId(first.project, groupAId), null);
      assert.equal(
        projectItemParentId(first.project, groupBId),
        groupCId
      );
      const locallyMoved = moveProjectItem(first.project, {
        itemId: groupAId,
        targetParentId: groupBId,
        targetIndex: 0
      });
      const localSave = await projectStore.save(locallyMoved, {
        expectedRevisionId: first.revisionId,
        reason: `local-half-of-parent-cycle-${choice}`
      });
      const nextEnvelope = envelope(plan({
        entries: [{
          id: 'group-a',
          kind: 'section',
          title: 'Group A'
        }, sermonEntry, {
          id: 'group-c',
          kind: 'section',
          title: 'Group C'
        }]
      }), { syncVersion: 4 });
      const reviewed = await coordinator.propose(nextEnvelope, options);
      assert.ok(
        reviewed.reconciliation,
        JSON.stringify(reviewed, null, 2)
      );
      assert.equal(reviewed.reconciliation.conflictCount, 1);
      const [structureConflict] = reviewed.reconciliation.conflicts;
      assert.equal(
        structureConflict.kind,
        'LOCAL_AND_COMMUNITY_STRUCTURE_CHANGED'
      );
      assert.equal(structureConflict.title, 'Conflicting section moves');

      const reconciled = await coordinator.replacePlanRevision(
        nextEnvelope,
        options,
        {
          expectedRevisionId: localSave.revisionId,
          decisions: [{
            conflictId: structureConflict.conflictId,
            choice
          }]
        }
      );
      assert.doesNotThrow(() => normalizeServiceProject(reconciled.project));
      if (choice === 'keep-local') {
        assert.equal(
          projectItemParentId(reconciled.project, groupAId),
          groupBId
        );
        assert.equal(
          projectItemParentId(reconciled.project, groupBId),
          groupCId
        );
        assert.equal(
          projectItemParentId(reconciled.project, groupCId),
          null
        );
      } else {
        assert.equal(
          projectItemParentId(reconciled.project, groupBId),
          groupAId
        );
        assert.equal(
          projectItemParentId(reconciled.project, groupAId),
          null
        );
        assert.equal(
          projectItemParentId(reconciled.project, groupCId),
          null
        );
      }
    });
  }
});

test('three-way reconciliation persists an exact ordered checksum-bound receipt', async t => {
  const initialPlan = plan({
    entries: [{
      id: 'receipt-a',
      kind: 'section',
      title: 'Receipt A'
    }, {
      id: 'receipt-b',
      kind: 'section',
      title: 'Receipt B'
    }]
  });
  const { coordinator, projectStore, options } = await harness(t);
  const first = await coordinator.importPlan(
    envelope(initialPlan),
    options
  );
  const itemAId = managedItemId('receipt-a');
  const itemBId = managedItemId('receipt-b');
  let local = updateGroupItem(first.project, {
    itemId: itemAId,
    title: 'Local receipt A',
    now: NOW
  });
  local = updateGroupItem(local, {
    itemId: itemBId,
    title: 'Local receipt B',
    now: NOW
  });
  const localSave = await projectStore.save(local, {
    expectedRevisionId: first.revisionId,
    reason: 'receipt-two-conflict-local'
  });
  const nextEnvelope = envelope(plan({
    entries: [{
      id: 'receipt-a',
      kind: 'section',
      title: 'Community receipt A'
    }, {
      id: 'receipt-b',
      kind: 'section',
      title: 'Community receipt B'
    }]
  }), { syncVersion: 4 });
  const reviewed = await coordinator.propose(nextEnvelope, options);
  assert.equal(reviewed.reconciliation.conflictCount, 2);
  const choiceByConflictId = new Map(
    reviewed.reconciliation.conflicts.map(conflict => [
      conflict.conflictId,
      conflict.itemId === itemAId ? 'use-community' : 'keep-local'
    ])
  );
  const reversedInput = [...reviewed.reconciliation.conflicts]
    .reverse()
    .map(conflict => ({
      conflictId: conflict.conflictId,
      choice: choiceByConflictId.get(conflict.conflictId)
    }));
  const reconciled = await coordinator.replacePlanRevision(
    nextEnvelope,
    options,
    {
      expectedRevisionId: localSave.revisionId,
      decisions: reversedInput
    }
  );
  const receipt =
    reconciled.project.planning.lastReconciliationReceipt;
  const expectedDecisions = reviewed.reconciliation.conflicts.map(
    conflict => ({
      conflictId: conflict.conflictId,
      choice: choiceByConflictId.get(conflict.conflictId)
    })
  );
  const expectedBody = {
    mode: 'three-way',
    previousPlanRevision:
      first.project.planning.source.planRevision,
    candidatePlanRevision: nextEnvelope.revision,
    previousBaselineProjectionSha256:
      first.project.planning.reconciliationBaseline.projectionSha256,
    candidateProjectionSha256:
      reconciled.project.planning.reconciliationBaseline.projectionSha256,
    mergeResultSha256:
      reconciliationProjectSha256(reconciled.project),
    previousLocalRevisionId: localSave.revisionId,
    conflictCount: 2,
    decisions: expectedDecisions,
    appliedAt: reconciled.project.planning.source.importedAt
  };
  assert.deepEqual(
    receipt,
    createCommunityServicePlanReconciliationReceipt(expectedBody)
  );
  assert.deepEqual(receipt.decisions, expectedDecisions);
  assert.equal(
    receipt.mergeResultSha256,
    reconciliationProjectSha256(reconciled.project)
  );
  assert.notEqual(
    receipt.mergeResultSha256,
    reviewed.reconciliation.mergeResultSha256
  );

  const predecessor = await projectStore.read(first.projectId, {
    revisionId: receipt.previousLocalRevisionId
  });
  assert.equal(predecessor.revisionId, localSave.revisionId);
  assert.equal(
    predecessor.project.planning.source.planRevision,
    receipt.previousPlanRevision
  );
  assert.equal(
    predecessor.project.planning.reconciliationBaseline.projectionSha256,
    receipt.previousBaselineProjectionSha256
  );

  const withoutReceiptRaw = JSON.parse(
    require('../src/services/project')
      .serializeServiceProject(reconciled.project)
  );
  delete withoutReceiptRaw.planning.lastReconciliationReceipt;
  const withoutReceipt = normalizeServiceProject(withoutReceiptRaw);
  assert.equal(
    reconciliationProjectSha256(reconciled.project),
    reconciliationProjectSha256(withoutReceipt)
  );
});

test('schema-v3 project with valid baseline-v1 uses legacy replacement and upgrades its baseline', async t => {
  const { coordinator, projectStore, options } = await harness(t);
  const first = await coordinator.importPlan(envelope(), options);
  const legacyRaw = JSON.parse(
    require('../src/services/project').serializeServiceProject(first.project)
  );
  assert.equal(legacyRaw.planning.schemaVersion, 3);
  legacyRaw.planning.reconciliationBaseline = legacyBaselineV1(
    legacyRaw.planning.reconciliationBaseline
  );
  const legacy = await projectStore.save(legacyRaw, {
    expectedRevisionId: first.revisionId,
    reason: 'valid-baseline-v1-fixture'
  });
  assert.equal(
    legacy.project.planning.reconciliationBaseline.schemaVersion,
    1
  );

  const nextEnvelope = envelope(plan({
    title: 'Baseline v1 replacement target'
  }), { syncVersion: 4 });
  const reviewed = await coordinator.propose(nextEnvelope, options);
  assert.equal(reviewed.reconciliation.mode, 'legacy-full-replace');
  assert.equal(reviewed.reconciliation.conflictCount, 1);
  const [conflict] = reviewed.reconciliation.conflicts;
  await assert.rejects(
    coordinator.replacePlanRevision(nextEnvelope, options, {
      expectedRevisionId: legacy.revisionId,
      decisions: [{
        conflictId: conflict.conflictId,
        choice: 'keep-local'
      }]
    }),
    expectImportCode('LEGACY_PLAN_REPLACEMENT_CONFIRMATION_REQUIRED')
  );

  const replaced = await coordinator.replacePlanRevision(
    nextEnvelope,
    options,
    {
      expectedRevisionId: legacy.revisionId,
      decisions: [{
        conflictId: conflict.conflictId,
        choice: 'use-community'
      }]
    }
  );
  assert.equal(replaced.status, 'replaced');
  assert.equal(replaced.project.planning.schemaVersion, 3);
  assert.equal(
    replaced.project.planning.reconciliationBaseline.schemaVersion,
    2
  );
  assert.equal(
    replaced.project.planning.reconciliationBaseline.planRevision,
    nextEnvelope.revision
  );
  assert.equal(
    replaced.project.planning.source.planRevision,
    nextEnvelope.revision
  );
  const receipt =
    replaced.project.planning.lastReconciliationReceipt;
  assert.deepEqual(
    receipt,
    createCommunityServicePlanReconciliationReceipt({
      mode: 'legacy-full-replace',
      previousPlanRevision:
        legacy.project.planning.source.planRevision,
      candidatePlanRevision: nextEnvelope.revision,
      previousBaselineProjectionSha256: null,
      candidateProjectionSha256:
        replaced.project.planning.reconciliationBaseline.projectionSha256,
      mergeResultSha256:
        reconciliationProjectSha256(replaced.project),
      previousLocalRevisionId: legacy.revisionId,
      conflictCount: 1,
      decisions: [{
        conflictId: conflict.conflictId,
        choice: 'use-community'
      }],
      appliedAt: replaced.project.planning.source.importedAt
    })
  );
  assert.equal(
    (await projectStore.read(first.projectId, {
      revisionId: receipt.previousLocalRevisionId
    })).revisionId,
    legacy.revisionId
  );
});

test('legacy imported projects require the distinct explicit full-replace fallback', async t => {
  const { coordinator, projectStore, options } = await harness(t);
  const first = await coordinator.importPlan(envelope(), options);
  const legacyRaw = JSON.parse(
    require('../src/services/project').serializeServiceProject(first.project)
  );
  legacyRaw.planning.schemaVersion = 2;
  delete legacyRaw.planning.reconciliationBaseline;
  const legacy = await projectStore.save(legacyRaw, {
    expectedRevisionId: first.revisionId,
    reason: 'legacy-fixture'
  });
  const nextEnvelope = envelope(plan({
    title: 'Legacy replacement target'
  }), { syncVersion: 4 });
  const reviewed = await coordinator.propose(nextEnvelope, options);
  assert.equal(reviewed.reconciliation.mode, 'legacy-full-replace');
  assert.equal(reviewed.reconciliation.conflictCount, 1);
  const [conflict] = reviewed.reconciliation.conflicts;

  await assert.rejects(
    coordinator.replacePlanRevision(nextEnvelope, options, {
      expectedRevisionId: legacy.revisionId,
      decisions: [{
        conflictId: conflict.conflictId,
        choice: 'keep-local'
      }]
    }),
    expectImportCode('LEGACY_PLAN_REPLACEMENT_CONFIRMATION_REQUIRED')
  );
  const replaced = await coordinator.replacePlanRevision(
    nextEnvelope,
    options,
    {
      expectedRevisionId: legacy.revisionId,
      decisions: [{
        conflictId: conflict.conflictId,
        choice: 'use-community'
      }]
    }
  );
  assert.equal(replaced.status, 'replaced');
  assert.equal(replaced.project.planning.schemaVersion, 3);
  assert.equal(replaced.project.title, 'Legacy replacement target');
});

test('legacy reconciliation authority remains stable while the real clock advances', async t => {
  let tick = 0;
  const clock = () =>
    new Date(Date.parse(NOW) + (tick++ * 1000));
  const { coordinator, projectStore, options } = await harness(t, { clock });
  const first = await coordinator.importPlan(envelope(), options);
  const legacyRaw = JSON.parse(
    require('../src/services/project').serializeServiceProject(first.project)
  );
  legacyRaw.planning.schemaVersion = 2;
  delete legacyRaw.planning.reconciliationBaseline;
  const legacy = await projectStore.save(legacyRaw, {
    expectedRevisionId: first.revisionId,
    reason: 'legacy-advancing-clock-fixture'
  });
  const nextEnvelope = envelope(plan({
    title: 'Stable legacy authority'
  }), { syncVersion: 4 });
  const firstReview = await coordinator.propose(nextEnvelope, options);
  const secondReview = await coordinator.propose(nextEnvelope, options);
  assert.equal(
    firstReview.reconciliation.mergeResultSha256,
    secondReview.reconciliation.mergeResultSha256
  );
  const [conflict] = secondReview.reconciliation.conflicts;

  const replaced = await coordinator.replacePlanRevision(
    nextEnvelope,
    options,
    {
      expectedRevisionId: legacy.revisionId,
      decisions: [{
        conflictId: conflict.conflictId,
        choice: 'use-community'
      }],
      expectedReconciliation: {
        mode: secondReview.reconciliation.mode,
        baselineProjectionSha256:
          secondReview.reconciliation.baselineProjectionSha256,
        candidateProjectionSha256:
          secondReview.reconciliation.candidateProjectionSha256,
        mergeResultSha256:
          secondReview.reconciliation.mergeResultSha256
      }
    }
  );
  assert.equal(replaced.status, 'replaced');
});

test('plan replacement fails closed for stale local CAS, blocked content, and non-Ready lifecycle', async t => {
  const { coordinator, projectStore, options } = await harness(t);
  const first = await coordinator.importPlan(envelope(), options);
  const nextEnvelope = envelope(plan({
    title: 'Updated Sunday Service'
  }), { syncVersion: 4 });

  await assert.rejects(
    coordinator.replacePlanRevision(nextEnvelope, options, {
      expectedRevisionId: 'f'.repeat(64)
    }),
    expectImportCode('LOCAL_PROJECT_CHANGED')
  );
  await assert.rejects(
    coordinator.replacePlanRevision(
      envelope(plan({ title: 'Draft revision' }), {
        status: 'draft',
        syncVersion: 4
      }),
      options,
      { expectedRevisionId: first.revisionId }
    ),
    expectImportCode('PLAN_REPLACEMENT_NOT_READY')
  );

  const blocked = await harness(t, { bibleFailure: true });
  const blockedFirst = await blocked.coordinator.importPlan(
    envelope(plan({ entries: [{
      id: 'opening',
      kind: 'section',
      title: 'Opening'
    }] })),
    blocked.options
  );
  await assert.rejects(
    blocked.coordinator.replacePlanRevision(
      envelope(plan({ title: 'Blocked update' }), { syncVersion: 4 }),
      blocked.options,
      { expectedRevisionId: blockedFirst.revisionId }
    ),
    expectImportCode('PLAN_REPLACEMENT_BLOCKED')
  );

  assert.equal((await projectStore.listRevisions(first.projectId)).total, 1);
});

test('coordinator source has no Load, Show, package, network, or fuzzy-match mutation dependency', async () => {
  const source = await fs.readFile(
    require.resolve(
      '../src/services/community/CommunityServicePlanImportCoordinator'
    ),
    'utf8'
  );
  assert.doesNotMatch(
    source,
    /\b(?:CurrentShowPackage|ShowPackage|fetch|ipcMain|ipcRenderer|similarity|fuzzy|planSermonPrimaryReading)\b/
  );
});
