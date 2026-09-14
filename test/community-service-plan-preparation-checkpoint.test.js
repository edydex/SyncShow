'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const {
  CommunityClientError
} = require('../src/services/community/CommunityClient');
const {
  COMMUNITY_SERVICE_PLAN_KIND,
  communityServicePlanRevision,
  serializeCommunityServicePlan
} = require('../src/services/community/CommunityServicePlan');
const {
  CommunityServicePlanImportCoordinator
} = require('../src/services/community/CommunityServicePlanImportCoordinator');
const {
  CommunitySermonSync
} = require('../src/services/community/CommunitySermonSync');
const {
  CommunitySongFamilyImportCoordinator
} = require('../src/services/community/CommunitySongFamilyImportCoordinator');
const {
  CommunitySongSync
} = require('../src/services/community/CommunitySongSync');
const {
  CommunitySyncStateStore
} = require('../src/services/community/CommunitySyncStateStore');
const {
  LocalSongLibrary
} = require('../src/services/project/LocalSongLibrary');
const {
  parseSongDocument,
  serializeSongDocument
} = require('../src/services/project/SongDocument');
const {
  ServiceProjectStore
} = require('../src/services/project/ServiceProjectStore');
const {
  LocalSermonLibrary
} = require('../src/services/sermon/LocalSermonLibrary');
const {
  serializeSermonDocument
} = require('../src/services/sermon/SermonDocument');

const NOW = '2026-07-29T18:00:00.000Z';
const CONNECTION_ID = 'connection-preparation-0001';
const SERVER_ID = 'wotbc-community';
const ACCESS_TOKEN = 'community-preparation-access-token-000001';
const SONG_ID = 'planned-song';
const SONG_SYNC_VERSION = 7;
const SONG_RECORD_REVISION = `song:${SONG_ID}:${SONG_SYNC_VERSION}`;
const SERMON_ID = 'planned-sermon';
const SERMON_SYNC_VERSION = 4;

async function temporaryRoot(t) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'syncshow-plan-preparation-checkpoint-')
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return fs.realpath(directory);
}

function songSource() {
  return [
    '---',
    `id: ${JSON.stringify(SONG_ID)}`,
    'title: "Planned Song"',
    'language: "en"',
    '---',
    '',
    '^1',
    'The exact song selected by the service plan',
    ''
  ].join('\n');
}

function remoteSong() {
  const source = songSource();
  return {
    syncId: SONG_ID,
    syncVersion: SONG_SYNC_VERSION,
    revision: SONG_RECORD_REVISION,
    syncDocuments: [{
      id: SONG_ID,
      source,
      revision: crypto.createHash('sha256').update(source).digest('hex')
    }],
    metadataOnly: false,
    title: 'Planned Song',
    alternateTitles: [],
    visibility: 'private',
    publishAt: null,
    archived: false,
    updatedAt: NOW
  };
}

function sermonDocument() {
  return {
    schemaVersion: 2,
    kind: 'syncshow-sermon',
    id: SERMON_ID,
    titles: { en: 'The Exact Planned Sermon' },
    defaultLanguage: 'en',
    speaker: { id: null, name: 'Pastor Example' },
    serviceDate: '2026-08-02',
    series: null,
    outline: [],
    sources: [],
    references: [],
    media: [],
    publication: {
      status: 'draft',
      visibility: 'private',
      publishedAt: null,
      canonicalUrl: null
    }
  };
}

function remoteSermon() {
  const documentSource = serializeSermonDocument(sermonDocument());
  return {
    syncId: SERMON_ID,
    syncVersion: SERMON_SYNC_VERSION,
    revision: crypto.createHash('sha256').update(documentSource).digest('hex'),
    documentSource,
    archived: false,
    updatedAt: NOW,
    sourceObjects: []
  };
}

function servicePlanEnvelope(sermonRevision) {
  const plan = {
    schemaVersion: 1,
    kind: COMMUNITY_SERVICE_PLAN_KIND,
    id: 'service-2026-08-02',
    title: 'Sunday Service — August 2',
    serviceDate: '2026-08-02',
    startTime: '10:30',
    teamNotes: '',
    entries: [{
      id: 'opening',
      kind: 'section',
      title: 'Opening'
    }, {
      id: 'planned-song-entry',
      kind: 'song',
      title: 'Planned Song',
      syncId: SONG_ID,
      expectedRevision: SONG_RECORD_REVISION,
      expectedSyncVersion: SONG_SYNC_VERSION
    }, {
      id: 'planned-sermon-entry',
      kind: 'sermon',
      title: 'The Exact Planned Sermon',
      syncId: SERMON_ID,
      expectedRevision: sermonRevision,
      expectedSyncVersion: SERMON_SYNC_VERSION
    }]
  };
  const documentSource = serializeCommunityServicePlan(plan);
  return {
    syncId: plan.id,
    syncVersion: 1,
    revision: communityServicePlanRevision(documentSource),
    documentSource,
    status: 'ready',
    changedAt: NOW
  };
}

function dependencySummary(review) {
  return review.preparationDependencies.map(dependency => ({
    kind: dependency.kind,
    syncId: dependency.syncId,
    expectedSyncVersion: dependency.expectedSyncVersion,
    expectedRevision: dependency.expectedRevision
  }));
}

test('a real song checkpoint narrows an offline plan retry to only its sermon', async t => {
  const root = await temporaryRoot(t);
  const songRoot = path.join(root, 'songs');
  const familyRecoveryAuthority = Symbol('plan-preparation-checkpoint');
  const songLibrary = new LocalSongLibrary({
    rootPath: songRoot,
    familyRecoveryAuthority,
    clock: () => new Date(NOW)
  });
  const familyImportCoordinator =
    new CommunitySongFamilyImportCoordinator({
      rootPath: songRoot,
      songLibrary,
      recoveryAuthority: familyRecoveryAuthority,
      clock: () => new Date(NOW)
    });
  const sermonLibrary = new LocalSermonLibrary({
    rootPath: path.join(root, 'sermons'),
    clock: () => new Date(NOW)
  });
  const stateStore = new CommunitySyncStateStore({
    storageRoot: path.join(root, 'community-state'),
    now: () => new Date(NOW)
  });
  const projectStore = new ServiceProjectStore({
    rootPath: path.join(root, 'projects'),
    clock: () => new Date(NOW)
  });

  const songRemote = remoteSong();
  const sermonRemote = remoteSermon();
  const envelope = servicePlanEnvelope(sermonRemote.revision);
  const options = {
    profileId: 'main-sanctuary',
    channels: [{
      id: 'primary',
      label: 'English',
      language: 'en'
    }]
  };
  const coordinator = new CommunityServicePlanImportCoordinator({
    serverId: SERVER_ID,
    connectionId: CONNECTION_ID,
    syncStateStore: stateStore,
    songLibrary,
    sermonLibrary,
    projectStore,
    bibleResolver: async () => {
      throw new Error('this plan has no Scripture dependency');
    },
    clock: () => new Date(NOW)
  });

  const songCalls = { get: 0, list: 0, create: 0, update: 0 };
  const songSync = new CommunitySongSync({
    client: {
      async getSong({ syncId }) {
        songCalls.get += 1;
        assert.equal(syncId, SONG_ID);
        return songRemote;
      },
      async listSongChanges() {
        songCalls.list += 1;
        throw new Error('an exact plan pull must not read the song feed');
      },
      async createSong() {
        songCalls.create += 1;
        throw new Error('plan preparation must not create Community songs');
      },
      async updateSong() {
        songCalls.update += 1;
        throw new Error('plan preparation must not update Community songs');
      }
    },
    localLibrary: songLibrary,
    familyImportCoordinator,
    stateStore,
    connectionId: CONNECTION_ID,
    accessTokenProvider: async () => ACCESS_TOKEN,
    now: () => new Date(NOW)
  });

  let sermonOnline = false;
  const sermonCalls = { get: 0, list: 0, create: 0, update: 0 };
  const sermonSync = new CommunitySermonSync({
    client: {
      async getSermon({ syncId }) {
        sermonCalls.get += 1;
        assert.equal(syncId, SERMON_ID);
        if (!sermonOnline) {
          throw new CommunityClientError(
            'NETWORK_ERROR',
            'Community is temporarily offline.',
            { retryable: true }
          );
        }
        return sermonRemote;
      },
      async listSermonChanges() {
        sermonCalls.list += 1;
        throw new Error('an exact plan pull must not read the sermon feed');
      },
      async createSermon() {
        sermonCalls.create += 1;
        throw new Error('plan preparation must not create Community sermons');
      },
      async updateSermon() {
        sermonCalls.update += 1;
        throw new Error('plan preparation must not update Community sermons');
      }
    },
    localLibrary: sermonLibrary,
    stateStore,
    connectionId: CONNECTION_ID,
    accessTokenProvider: async () => ACCESS_TOKEN,
    now: () => new Date(NOW)
  });

  const initial = await coordinator.review(envelope, options);
  assert.equal(initial.proposal.status, 'blocked');
  assert.deepEqual(dependencySummary(initial), [{
    kind: 'song',
    syncId: SONG_ID,
    expectedSyncVersion: SONG_SYNC_VERSION,
    expectedRevision: SONG_RECORD_REVISION
  }, {
    kind: 'sermon',
    syncId: SERMON_ID,
    expectedSyncVersion: SERMON_SYNC_VERSION,
    expectedRevision: sermonRemote.revision
  }]);

  const songDependency = initial.preparationDependencies[0];
  const songResult = await songSync.pullSong(songDependency.syncId, {
    expectedSyncVersion: songDependency.expectedSyncVersion,
    expectedRevision: songDependency.expectedRevision
  });
  assert.equal(songResult.status, 'synced');
  assert.equal(songResult.pulled, 1);
  const songCheckpoint = await stateStore.getSongState(
    CONNECTION_ID,
    SONG_ID
  );
  const remoteSongDocument = songRemote.syncDocuments[0];
  const canonicalSongSource = serializeSongDocument(
    parseSongDocument(remoteSongDocument.source)
  );
  const localSongDocument = await songLibrary.read(SONG_ID);
  assert.notEqual(
    remoteSongDocument.source,
    canonicalSongSource,
    'the regression fixture must use valid noncanonical Community source'
  );
  assert.equal(localSongDocument.source, canonicalSongSource);
  assert.notEqual(
    remoteSongDocument.revision,
    localSongDocument.revision,
    'raw Community and canonical local checksums must exercise separate domains'
  );
  const songSnapshot = await songLibrary.withCurrentSnapshot(session =>
    session.snapshotFamily(songCheckpoint.localFamilyId));
  assert.equal(songSnapshot.familyId, songCheckpoint.localFamilyId);
  assert.deepEqual(
    songSnapshot.documents.map(document => ({
      songId: document.songId,
      revision: document.revision
    })),
    Object.entries(songCheckpoint.documents).map(([songId, document]) => ({
      songId,
      revision: document.localRevision
    }))
  );
  for (const [songId, document] of Object.entries(songCheckpoint.documents)) {
    const remoteDocument = songRemote.syncDocuments.find(candidate =>
      candidate.id === songId);
    assert.equal(document.remoteRevision, remoteDocument.revision);
    assert.notEqual(document.remoteRevision, document.localRevision);
  }

  const sermonDependency = initial.preparationDependencies[1];
  const offline = await sermonSync.pullSermon(sermonDependency.syncId, {
    expectedSyncVersion: sermonDependency.expectedSyncVersion,
    expectedRevision: sermonDependency.expectedRevision
  });
  assert.equal(offline.status, 'offline');

  const retryReview = await coordinator.review(envelope, options);
  assert.equal(retryReview.proposal.status, 'blocked');
  assert.deepEqual(
    retryReview.proposal.blockers.map(blocker => blocker.code),
    ['LOCAL_SERMON_MISSING']
  );
  assert.deepEqual(dependencySummary(retryReview), [{
    kind: 'sermon',
    syncId: SERMON_ID,
    expectedSyncVersion: SERMON_SYNC_VERSION,
    expectedRevision: sermonRemote.revision
  }]);

  sermonOnline = true;
  for (const dependency of retryReview.preparationDependencies) {
    assert.equal(dependency.kind, 'sermon');
    const result = await sermonSync.pullSermon(dependency.syncId, {
      expectedSyncVersion: dependency.expectedSyncVersion,
      expectedRevision: dependency.expectedRevision
    });
    assert.equal(result.status, 'synced');
    assert.equal(result.pulled, 1);
  }

  const completed = await coordinator.review(envelope, options);
  assert.equal(completed.proposal.status, 'ready-to-import');
  assert.deepEqual(completed.preparationDependencies, []);
  assert.deepEqual(songCalls, { get: 1, list: 0, create: 0, update: 0 });
  assert.deepEqual(sermonCalls, { get: 2, list: 0, create: 0, update: 0 });

  const state = await stateStore.getConnectionState(CONNECTION_ID);
  assert.equal(state.cursor, null);
  assert.equal(state.sermonCursor, null);
  assert.equal(state.songs[SONG_ID].syncVersion, SONG_SYNC_VERSION);
  assert.equal(state.songs[SONG_ID].remoteRevision, SONG_RECORD_REVISION);
  assert.equal(state.sermons[SERMON_ID].syncVersion, SERMON_SYNC_VERSION);
  assert.equal(state.sermons[SERMON_ID].remoteRevision, sermonRemote.revision);
});
