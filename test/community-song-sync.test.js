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
  CommunitySongSync
} = require('../src/services/community/CommunitySongSync');
const {
  CommunitySyncStateStore
} = require('../src/services/community/CommunitySyncStateStore');
const {
  LocalSongLibrary,
  idStorageKey
} = require('../src/services/project/LocalSongLibrary');

const ACCESS_TOKEN = 'community-access-token-0000000001';
const CONNECTION_ID = 'connection-00000001';
const NOW = '2026-07-25T12:00:00.000Z';

async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'syncshow-community-sync-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const realRoot = await fs.realpath(root);
  return {
    library: new LocalSongLibrary({ rootPath: path.join(realRoot, 'songs') }),
    stateStore: new CommunitySyncStateStore({
      storageRoot: path.join(realRoot, 'community-state'),
      now: () => new Date(NOW)
    })
  };
}

function songSource({
  id = 'amazing-grace',
  title = 'Amazing Grace',
  language = 'en',
  translationOf = null,
  line = 'Amazing grace'
} = {}) {
  const metadata = [
    '---',
    `id: ${id}`,
    `title: ${JSON.stringify(title)}`,
    `language: ${language}`
  ];
  if (translationOf) metadata.push(`translationOf: ${translationOf}`);
  return `${metadata.join('\n')}\n---\n\n^1\n${line}\n`;
}

async function localDocuments(library, ids) {
  return Promise.all(ids.map(async id => {
    const item = await library.read(id);
    return {
      id,
      source: item.source,
      revision: item.revision
    };
  }));
}

function remoteSong({
  syncId = 'amazing-grace',
  syncVersion = 1,
  syncDocuments = [],
  title = 'Amazing Grace',
  alternateTitles = [],
  visibility = 'private',
  publishAt = null,
  archived = false
} = {}) {
  return {
    syncId,
    syncVersion,
    revision: `song:${syncId}:${syncVersion}`,
    syncDocuments,
    metadataOnly: syncDocuments.length === 0,
    title,
    alternateTitles,
    visibility,
    publishAt,
    archived,
    updatedAt: NOW
  };
}

function clientStub(overrides = {}) {
  return {
    listSongChanges: async () => ({ items: [], nextCursor: 'cursor-1', hasMore: false }),
    createSong: async input => remoteSong({
      syncId: input.syncId,
      syncDocuments: input.syncDocuments,
      visibility: input.visibility,
      publishAt: input.publishAt
    }),
    updateSong: async input => remoteSong({
      syncId: input.syncId,
      syncVersion: input.expectedSyncVersion + 1,
      syncDocuments: input.syncDocuments || [],
      visibility: input.visibility || 'private',
      publishAt: input.publishAt || null
    }),
    getSong: async ({ syncId }) => remoteSong({ syncId }),
    ...overrides
  };
}

function synchronizer({ client, library, stateStore }) {
  return new CommunitySongSync({
    client,
    localLibrary: library,
    stateStore,
    connectionId: CONNECTION_ID,
    accessTokenProvider: async () => ACCESS_TOKEN,
    now: () => new Date(NOW)
  });
}

test('offline synchronization reads local songs first and leaves them authoritative and usable', async t => {
  const { library, stateStore } = await workspace(t);
  const saved = await library.saveSource(songSource());
  let localWasReadable = false;
  const client = clientStub({
    listSongChanges: async () => {
      localWasReadable = (await library.read(saved.song.id)).revision === saved.revision;
      throw new CommunityClientError('NETWORK_ERROR', 'offline', { retryable: true });
    }
  });

  const result = await synchronizer({ client, library, stateStore }).sync();
  assert.equal(localWasReadable, true);
  assert.equal(result.status, 'offline');
  assert.equal((await library.read(saved.song.id)).revision, saved.revision);
  assert.equal(result.pulled, 0);
  assert.equal(result.pushed, 0);
});

test('a new local family uploads original before translations and defaults to private', async t => {
  const { library, stateStore } = await workspace(t);
  await library.saveSource(songSource({
    id: 'root-song',
    title: 'Root Song',
    line: 'Original'
  }));
  await library.saveSource(songSource({
    id: 'root-song-ru',
    title: 'Корневая песня',
    language: 'ru',
    translationOf: 'root-song',
    line: 'Перевод'
  }), { expectedRevision: null });
  const creates = [];
  const client = clientStub({
    createSong: async input => {
      creates.push(input);
      return remoteSong({
        syncId: input.syncId,
        syncDocuments: input.syncDocuments,
        title: 'Root Song',
        visibility: input.visibility,
        publishAt: input.publishAt
      });
    }
  });

  const result = await synchronizer({ client, library, stateStore }).sync();
  assert.equal(result.status, 'synced');
  assert.equal(result.pushed, 1);
  assert.equal(creates.length, 1);
  assert.equal(creates[0].syncId, 'root-song');
  assert.deepEqual(creates[0].syncDocuments.map(document => document.id), [
    'root-song',
    'root-song-ru'
  ]);
  assert.equal(creates[0].visibility, 'private');
  assert.equal(creates[0].publishAt, null);
});

test('translation-first wire order is topologically imported with its original first', async t => {
  const { library, stateStore } = await workspace(t);
  const rootSource = songSource({
    id: 'wire-root',
    title: 'Wire Root',
    line: 'Original'
  });
  const translationSource = songSource({
    id: 'wire-ru',
    title: 'Дротовий',
    language: 'ru',
    translationOf: 'wire-root',
    line: 'Переклад'
  });
  const document = (id, source) => ({
    id,
    source,
    revision: crypto.createHash('sha256').update(source).digest('hex')
  });
  const client = clientStub({
    listSongChanges: async () => ({
      items: [remoteSong({
        syncId: 'wire-root',
        syncDocuments: [
          document('wire-ru', translationSource),
          document('wire-root', rootSource)
        ],
        title: 'Wire Root'
      })],
      nextCursor: 'wire-final',
      hasMore: false
    })
  });

  const result = await synchronizer({ client, library, stateStore }).sync();
  assert.equal(result.pulled, 1);
  assert.equal((await library.read('wire-root')).song.translationOf, null);
  assert.equal((await library.read('wire-ru')).song.translationOf, 'wire-root');
});

test('unique title matching enriches a legacy metadata record instead of creating a duplicate', async t => {
  const { library, stateStore } = await workspace(t);
  await library.saveSource(songSource({
    id: 'syncshow-import-id',
    title: 'Amazing Grace'
  }));
  const updates = [];
  let creates = 0;
  const legacy = remoteSong({
    syncId: 'legacy-record-31',
    syncVersion: 7,
    syncDocuments: [],
    title: 'Amazing Grace'
  });
  const client = clientStub({
    listSongChanges: async () => ({
      items: [legacy],
      nextCursor: 'cursor-legacy',
      hasMore: false
    }),
    createSong: async () => {
      creates += 1;
      throw new Error('must not create duplicate');
    },
    updateSong: async input => {
      updates.push(input);
      return remoteSong({
        syncId: legacy.syncId,
        syncVersion: 8,
        syncDocuments: input.syncDocuments,
        title: legacy.title
      });
    }
  });

  const result = await synchronizer({ client, library, stateStore }).sync();
  assert.equal(result.pushed, 1);
  assert.equal(creates, 0);
  assert.equal(updates[0].syncId, 'legacy-record-31');
  assert.equal(updates[0].expectedSyncVersion, 7);
  assert.equal(updates[0].syncDocuments[0].id, 'syncshow-import-id');
  const state = await stateStore.getSongState(CONNECTION_ID, 'legacy-record-31');
  assert.equal(state.localFamilyId, 'syncshow-import-id');
});

test('a Russian local title uniquely matches the legacy bilingual alternate title', async t => {
  const { library, stateStore } = await workspace(t);
  await library.saveSource(songSource({
    id: 'o-blagodat-local',
    title: 'О благодать',
    language: 'ru',
    line: 'О благодать'
  }));
  let creates = 0;
  const updates = [];
  const client = clientStub({
    listSongChanges: async () => ({
      items: [remoteSong({
        syncId: 'legacy-amazing-grace',
        syncVersion: 2,
        syncDocuments: [],
        title: 'Amazing Grace',
        alternateTitles: ['О благодать']
      })],
      nextCursor: 'cursor-bilingual',
      hasMore: false
    }),
    createSong: async () => {
      creates += 1;
      throw new Error('must enrich, not duplicate');
    },
    updateSong: async input => {
      updates.push(input);
      return remoteSong({
        syncId: input.syncId,
        syncVersion: 3,
        syncDocuments: input.syncDocuments,
        title: 'Amazing Grace'
      });
    }
  });

  await synchronizer({ client, library, stateStore }).sync();
  assert.equal(creates, 0);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].syncId, 'legacy-amazing-grace');
});

test('ambiguous title matching neither creates a duplicate nor overwrites either side', async t => {
  const { library, stateStore } = await workspace(t);
  await library.saveSource(songSource({ id: 'local-one', title: 'Same Song' }));
  await library.saveSource(songSource({ id: 'local-two', title: 'Same Song', line: 'Other' }));
  let writes = 0;
  const client = clientStub({
    listSongChanges: async () => ({
      items: [remoteSong({
        syncId: 'legacy-same-song',
        syncDocuments: [],
        title: 'Same Song'
      })],
      nextCursor: 'cursor-ambiguous',
      hasMore: false
    }),
    createSong: async () => {
      writes += 1;
      throw new Error('must not create');
    },
    updateSong: async () => {
      writes += 1;
      throw new Error('must not update');
    }
  });

  const result = await synchronizer({ client, library, stateStore }).sync();
  assert.equal(writes, 0);
  assert.ok(result.conflicts >= 1);
  assert.ok(result.warnings.some(warning => warning.code === 'AMBIGUOUS_REMOTE_MATCH'));
  assert.equal((await library.list()).total, 2);
});

test('remote tombstones archive sync state but never delete the local song', async t => {
  const { library, stateStore } = await workspace(t);
  const saved = await library.saveSource(songSource());
  const client = clientStub({
    listSongChanges: async () => ({
      items: [remoteSong({
        syncDocuments: [],
        archived: true
      })],
      nextCursor: 'cursor-archived',
      hasMore: false
    })
  });

  const result = await synchronizer({ client, library, stateStore }).sync();
  assert.equal(result.archived, 1);
  assert.equal((await library.read(saved.song.id)).revision, saved.revision);
  assert.equal(
    (await stateStore.getSongState(CONNECTION_ID, saved.song.id)).archived,
    true
  );
});

test('independent first-sync edits preserve remote source as a conflict and retain local current pointer', async t => {
  const { library, stateStore } = await workspace(t);
  const local = await library.saveSource(songSource({ line: 'Local wording' }));
  const remoteSource = songSource({ line: 'Remote wording' });
  const remoteDocument = {
    id: 'amazing-grace',
    source: remoteSource,
    revision: crypto.createHash('sha256').update(remoteSource).digest('hex')
  };
  let remoteWrites = 0;
  const client = clientStub({
    listSongChanges: async () => ({
      items: [remoteSong({ syncDocuments: [remoteDocument] })],
      nextCursor: 'cursor-conflict',
      hasMore: false
    }),
    createSong: async () => {
      remoteWrites += 1;
      throw new Error('must not create');
    },
    updateSong: async () => {
      remoteWrites += 1;
      throw new Error('must not update');
    }
  });

  const result = await synchronizer({ client, library, stateStore }).sync();
  assert.equal(remoteWrites, 0);
  assert.equal(result.conflicts, 1);
  assert.equal((await library.read(local.song.id)).revision, local.revision);
  const conflict = (await stateStore.getSongState(CONNECTION_ID, local.song.id)).conflict;
  assert.equal(conflict.code, 'INDEPENDENT_FIRST_SYNC');
  assert.equal(conflict.remoteDocuments[0].source, remoteSource);
});

test('a local-only visibility selection persists offline and creates scheduled-public on retry', async t => {
  const { library, stateStore } = await workspace(t);
  const local = await library.saveSource(songSource());
  await stateStore.setSongVisibility(CONNECTION_ID, local.song.id, {
    visibility: 'scheduled-public',
    publishAt: '2026-07-27T17:00:00.000Z'
  });

  const offlineClient = clientStub({
    listSongChanges: async () => {
      throw new CommunityClientError('NETWORK_ERROR', 'offline', { retryable: true });
    }
  });
  const offline = await synchronizer({
    client: offlineClient,
    library,
    stateStore
  }).syncSong(local.song.id);
  assert.equal(offline.status, 'offline');
  assert.equal(
    (await stateStore.getSongState(CONNECTION_ID, local.song.id))
      .pendingVisibility.visibility,
    'scheduled-public'
  );

  const creates = [];
  const onlineClient = clientStub({
    createSong: async input => {
      creates.push(input);
      return remoteSong({
        syncId: input.syncId,
        syncDocuments: input.syncDocuments,
        visibility: input.visibility,
        publishAt: input.publishAt
      });
    }
  });
  const online = await synchronizer({
    client: onlineClient,
    library,
    stateStore
  }).syncSong(local.song.id);
  assert.equal(online.pushed, 1);
  assert.equal(creates[0].visibility, 'scheduled-public');
  assert.equal(creates[0].publishAt, '2026-07-27T17:00:00.000Z');
});

test('local changes after a baseline are pushed by CAS and never replaced by stale remote source', async t => {
  const { library, stateStore } = await workspace(t);
  const first = await library.saveSource(songSource({ line: 'Baseline' }));
  await stateStore.saveConnectionState(CONNECTION_ID, {
    cursor: 'cursor-baseline',
    lastSyncAt: NOW,
    songs: {
      'amazing-grace': {
        syncId: 'amazing-grace',
        localFamilyId: 'amazing-grace',
        remoteTitle: 'Amazing Grace',
        alternateTitles: [],
        syncVersion: 4,
        remoteRevision: 'song:amazing-grace:4',
        documents: {
          'amazing-grace': {
            localRevision: first.revision,
            remoteRevision: first.revision
          }
        },
        visibility: 'private',
        publishAt: null,
        pendingVisibility: null,
        archived: false,
        metadataOnly: false,
        lastSyncedAt: NOW,
        conflict: null
      }
    }
  });
  const changed = await library.saveSource(songSource({ line: 'Local edit wins' }), {
    expectedSongId: first.song.id,
    expectedRevision: first.revision
  });
  const baselineDocument = {
    id: first.song.id,
    source: first.source,
    revision: first.revision
  };
  const updates = [];
  const client = clientStub({
    listSongChanges: async () => ({
      items: [remoteSong({
        syncVersion: 4,
        syncDocuments: [baselineDocument]
      })],
      nextCursor: 'cursor-unchanged-remote',
      hasMore: false
    }),
    updateSong: async input => {
      updates.push(input);
      return remoteSong({
        syncVersion: 5,
        syncDocuments: input.syncDocuments
      });
    }
  });

  const result = await synchronizer({ client, library, stateStore }).sync();
  assert.equal(result.pushed, 1);
  assert.equal(updates[0].expectedSyncVersion, 4);
  assert.equal(updates[0].syncDocuments[0].revision, changed.revision);
  assert.equal((await library.read(first.song.id)).revision, changed.revision);
  assert.equal(
    (await library.read(first.song.id, { revision: first.revision })).revision,
    first.revision,
    'immutable baseline revision remains available'
  );
});

test('multi-document pull rolls back an earlier current pointer when a later CAS save fails', async t => {
  const { library, stateStore } = await workspace(t);
  const original = await library.saveSource(songSource({
    id: 'atomic-root',
    title: 'Atomic Root',
    line: 'Local original'
  }));
  const translation = await library.saveSource(songSource({
    id: 'atomic-ru',
    title: 'Атомний',
    language: 'ru',
    translationOf: 'atomic-root',
    line: 'Local translation'
  }), { expectedRevision: null });
  await stateStore.saveConnectionState(CONNECTION_ID, {
    cursor: 'atomic-baseline',
    lastSyncAt: NOW,
    songs: {
      'atomic-root': {
        syncId: 'atomic-root',
        localFamilyId: 'atomic-root',
        remoteTitle: 'Atomic Root',
        alternateTitles: [],
        syncVersion: 1,
        remoteRevision: 'song:atomic-root:1',
        documents: {
          'atomic-root': {
            localRevision: original.revision,
            remoteRevision: original.revision
          },
          'atomic-ru': {
            localRevision: translation.revision,
            remoteRevision: translation.revision
          }
        },
        visibility: 'private',
        publishAt: null,
        archived: false,
        metadataOnly: false,
        lastSyncedAt: NOW
      }
    }
  });
  const remoteOriginalSource = songSource({
    id: 'atomic-root',
    title: 'Atomic Root',
    line: 'Remote original'
  });
  const remoteTranslationSource = songSource({
    id: 'atomic-ru',
    title: 'Атомний',
    language: 'ru',
    translationOf: 'atomic-root',
    line: 'Remote translation'
  });
  const remoteDocuments = [remoteOriginalSource, remoteTranslationSource].map(source => {
    const id = /id: ([^\n]+)/.exec(source)[1];
    return {
      id,
      source,
      revision: crypto.createHash('sha256').update(source).digest('hex')
    };
  });
  const flakyLibrary = {
    rootPath: library.rootPath,
    list: library.list.bind(library),
    read: library.read.bind(library),
    saveSource: async (source, options) => {
      if (/Remote translation/.test(source)) {
        const error = new Error('simulated stale translation editor');
        error.code = 'SONG_CONFLICT';
        throw error;
      }
      return library.saveSource(source, options);
    }
  };
  const client = clientStub({
    listSongChanges: async () => ({
      items: [remoteSong({
        syncId: 'atomic-root',
        syncVersion: 2,
        syncDocuments: remoteDocuments,
        title: 'Atomic Root'
      })],
      nextCursor: 'atomic-final',
      hasMore: false
    })
  });

  const result = await synchronizer({
    client,
    library: flakyLibrary,
    stateStore
  }).sync();
  assert.equal(result.conflicts, 1);
  assert.equal((await library.read('atomic-root')).revision, original.revision);
  assert.equal((await library.read('atomic-ru')).revision, translation.revision);
  assert.equal(
    (await stateStore.getSongState(CONNECTION_ID, 'atomic-root')).conflict.code,
    'LOCAL_IMPORT_CONFLICT'
  );
});

test('failed new-family pull withdraws an already-created pointer while retaining immutable recovery data', async t => {
  const { library, stateStore } = await workspace(t);
  const rootSource = songSource({
    id: 'new-atomic-root',
    title: 'New Atomic Root',
    line: 'Remote root'
  });
  const translationSource = songSource({
    id: 'new-atomic-ru',
    title: 'Новий атомний',
    language: 'ru',
    translationOf: 'new-atomic-root',
    line: 'Fail this translation'
  });
  const documents = [rootSource, translationSource].map(source => ({
    id: /id: ([^\n]+)/.exec(source)[1],
    source,
    revision: crypto.createHash('sha256').update(source).digest('hex')
  }));
  const flakyLibrary = {
    rootPath: library.rootPath,
    list: library.list.bind(library),
    read: library.read.bind(library),
    saveSource: async (source, options) => {
      if (/Fail this translation/.test(source)) {
        const error = new Error('simulated translation failure');
        error.code = 'SONG_CONFLICT';
        throw error;
      }
      return library.saveSource(source, options);
    }
  };
  const client = clientStub({
    listSongChanges: async () => ({
      items: [remoteSong({
        syncId: 'new-atomic-root',
        syncDocuments: documents,
        title: 'New Atomic Root'
      })],
      nextCursor: 'new-atomic-final',
      hasMore: false
    })
  });

  const result = await synchronizer({
    client,
    library: flakyLibrary,
    stateStore
  }).sync();
  assert.equal(result.conflicts, 1);
  await assert.rejects(
    library.read('new-atomic-root'),
    error => error.code === 'SONG_NOT_FOUND'
  );
  assert.equal((await library.list()).total, 0);
});

test('remote omission retains a local translation as a visible conflict and does not re-upload it', async t => {
  const { library, stateStore } = await workspace(t);
  const original = await library.saveSource(songSource({
    id: 'retained-root',
    title: 'Retained Root',
    line: 'Local original'
  }));
  const translation = await library.saveSource(songSource({
    id: 'retained-ru',
    title: 'Збережений',
    language: 'ru',
    translationOf: 'retained-root',
    line: 'Keep this translation'
  }), { expectedRevision: null });
  await stateStore.saveConnectionState(CONNECTION_ID, {
    cursor: 'retained-baseline',
    lastSyncAt: NOW,
    songs: {
      'retained-root': {
        syncId: 'retained-root',
        localFamilyId: 'retained-root',
        remoteTitle: 'Retained Root',
        alternateTitles: [],
        syncVersion: 1,
        remoteRevision: 'song:retained-root:1',
        documents: {
          'retained-root': {
            localRevision: original.revision,
            remoteRevision: original.revision
          },
          'retained-ru': {
            localRevision: translation.revision,
            remoteRevision: translation.revision
          }
        },
        visibility: 'private',
        publishAt: null,
        archived: false,
        metadataOnly: false,
        lastSyncedAt: NOW
      }
    }
  });
  const remoteSource = songSource({
    id: 'retained-root',
    title: 'Retained Root',
    line: 'Remote changed original'
  });
  const remoteDocument = {
    id: 'retained-root',
    source: remoteSource,
    revision: crypto.createHash('sha256').update(remoteSource).digest('hex')
  };
  let updates = 0;
  const client = clientStub({
    listSongChanges: async () => ({
      items: [remoteSong({
        syncId: 'retained-root',
        syncVersion: 2,
        syncDocuments: [remoteDocument],
        title: 'Retained Root'
      })],
      nextCursor: 'retained-final',
      hasMore: false
    }),
    updateSong: async () => {
      updates += 1;
      throw new Error('retained translation must not auto-upload');
    }
  });

  const result = await synchronizer({ client, library, stateStore }).sync();
  assert.equal(updates, 0);
  assert.equal(result.conflicts, 1);
  assert.match((await library.read('retained-root')).source, /Remote changed original/);
  assert.equal((await library.read('retained-ru')).revision, translation.revision);
  const state = await stateStore.getSongState(CONNECTION_ID, 'retained-root');
  assert.equal(state.conflict.code, 'RETAINED_LOCAL_DOCUMENTS');
  assert.equal(state.conflict.localRevision.length, 64);
});

test('a missing previously tracked local document becomes a conflict and never shrinks Community', async t => {
  const { library, stateStore } = await workspace(t);
  await library.saveSource(songSource({
    id: 'protected-family',
    title: 'Protected Family',
    line: 'Original'
  }));
  await library.saveSource(songSource({
    id: 'protected-family-ru',
    title: 'Защищенная семья',
    language: 'ru',
    translationOf: 'protected-family',
    line: 'Перевод'
  }), { expectedRevision: null });

  let remote = null;
  let cursor = 0;
  const updates = [];
  const client = clientStub({
    listSongChanges: async () => ({
      items: [],
      nextCursor: `protected-cursor-${cursor += 1}`,
      hasMore: false
    }),
    createSong: async input => {
      remote = remoteSong({
        syncId: input.syncId,
        syncVersion: 1,
        syncDocuments: input.syncDocuments,
        title: 'Protected Family'
      });
      return remote;
    },
    getSong: async () => remote,
    updateSong: async input => {
      updates.push(input);
      return remote;
    }
  });
  const sync = synchronizer({ client, library, stateStore });
  await sync.sync();

  await fs.unlink(path.join(
    library.rootPath,
    idStorageKey('protected-family-ru'),
    'current.json'
  ));

  const result = await sync.sync();
  const state = await stateStore.getSongState(CONNECTION_ID, 'protected-family');
  assert.equal(result.pushed, 0);
  assert.equal(result.conflicts, 1);
  assert.equal(result.warnings[0].code, 'MISSING_LOCAL_DOCUMENTS');
  assert.equal(state.conflict.code, 'MISSING_LOCAL_DOCUMENTS');
  assert.deepEqual(
    state.conflict.remoteDocuments.map(document => document.id),
    ['protected-family', 'protected-family-ru']
  );
  assert.equal(updates.length, 0, 'generic sync must not publish a smaller family');

  await assert.rejects(
    sync.resolveConflict('protected-family', {
      strategy: 'keep-local',
      expectedSyncVersion: state.syncVersion,
      expectedLocalRevision: state.conflict.localRevision
    }),
    error => error.code === 'MISSING_LOCAL_DOCUMENTS'
  );
  assert.equal(updates.length, 0, 'generic keep-local must not delete the missing document remotely');

  const restored = await sync.resolveConflict('protected-family', {
    strategy: 'keep-remote',
    expectedSyncVersion: state.syncVersion,
    expectedLocalRevision: state.conflict.localRevision
  });
  assert.equal(restored.resolved, true);
  assert.equal((await library.read('protected-family-ru')).song.translationOf, 'protected-family');
});

test('syncSong resolves a translation ID to its original family', async t => {
  const { library, stateStore } = await workspace(t);
  await library.saveSource(songSource({ id: 'family-root', title: 'Root' }));
  await library.saveSource(songSource({
    id: 'family-ru',
    title: 'Корень',
    language: 'ru',
    translationOf: 'family-root'
  }), { expectedRevision: null });
  const creates = [];
  const client = clientStub({
    createSong: async input => {
      creates.push(input);
      return remoteSong({
        syncId: input.syncId,
        syncDocuments: input.syncDocuments,
        title: 'Root'
      });
    }
  });

  await synchronizer({ client, library, stateStore }).syncSong('family-ru');
  assert.equal(creates.length, 1);
  assert.equal(creates[0].syncId, 'family-root');
  assert.deepEqual(creates[0].syncDocuments.map(document => document.id), [
    'family-root',
    'family-ru'
  ]);
});

test('remote pagination advances through more than 100 records before saving the cursor', async t => {
  const { library, stateStore } = await workspace(t);
  const cursors = [];
  const firstPage = Array.from({ length: 100 }, (_, index) => remoteSong({
    syncId: `metadata-${index}`,
    syncDocuments: [],
    title: `Remote metadata ${index}`
  }));
  const secondPage = [remoteSong({
    syncId: 'metadata-100',
    syncDocuments: [],
    title: 'Remote metadata 100'
  })];
  const client = clientStub({
    listSongChanges: async ({ cursor }) => {
      cursors.push(cursor);
      return cursor === null
        ? { items: firstPage, nextCursor: 'page-2', hasMore: true }
        : { items: secondPage, nextCursor: 'final-cursor', hasMore: false };
    }
  });

  const result = await synchronizer({ client, library, stateStore }).sync();
  assert.deepEqual(cursors, [null, 'page-2']);
  assert.equal(result.cursor, 'final-cursor');
  assert.equal(
    Object.keys((await stateStore.getConnectionState(CONNECTION_ID)).songs).length,
    101
  );
});

test('a multi-page snapshot refuses to persist an intermediate cursor as the final checkpoint', async t => {
  const { library, stateStore } = await workspace(t);
  const client = clientStub({
    listSongChanges: async ({ cursor }) => cursor === null
      ? {
          items: [remoteSong({ syncId: 'metadata-a', syncDocuments: [] })],
          nextCursor: 'intermediate',
          hasMore: true
        }
      : {
          items: [remoteSong({ syncId: 'metadata-b', syncDocuments: [] })],
          nextCursor: 'intermediate',
          hasMore: false
        }
  });

  await assert.rejects(
    synchronizer({ client, library, stateStore }).sync(),
    error => error.code === 'INVALID_REMOTE_CURSOR'
  );
  assert.equal((await stateStore.getConnectionState(CONNECTION_ID)).cursor, null);
});

test('cancellation after a remote response prevents local or sync-state mutation', async t => {
  const { library, stateStore } = await workspace(t);
  const local = await library.saveSource(songSource({ line: 'Keep local' }));
  const controller = new AbortController();
  const remoteSource = songSource({ line: 'Do not apply after cancellation' });
  const client = clientStub({
    listSongChanges: async () => {
      controller.abort();
      return {
        items: [remoteSong({
          syncDocuments: [{
            id: local.song.id,
            source: remoteSource,
            revision: crypto.createHash('sha256').update(remoteSource).digest('hex')
          }]
        })],
        nextCursor: 'cancelled-cursor',
        hasMore: false
      };
    }
  });

  await assert.rejects(
    synchronizer({ client, library, stateStore }).sync({ signal: controller.signal }),
    error => error.code === 'SYNC_CANCELLED' && error.name === 'AbortError'
  );
  assert.equal((await library.read(local.song.id)).revision, local.revision);
  assert.equal((await stateStore.getConnectionState(CONNECTION_ID)).cursor, null);
  assert.deepEqual((await stateStore.getConnectionState(CONNECTION_ID)).songs, {});
});

test('conflict resolution uses fresh remote and local revisions before keeping either side', async t => {
  const { library, stateStore } = await workspace(t);
  const local = await library.saveSource(songSource({ line: 'Local choice' }));
  const remoteSource = songSource({ line: 'Remote choice' });
  const remoteDocument = {
    id: local.song.id,
    source: remoteSource,
    revision: crypto.createHash('sha256').update(remoteSource).digest('hex')
  };
  const firstRemote = remoteSong({ syncDocuments: [remoteDocument] });
  const updates = [];
  const client = clientStub({
    listSongChanges: async () => ({
      items: [firstRemote],
      nextCursor: 'cursor-conflict-resolution',
      hasMore: false
    }),
    getSong: async () => firstRemote,
    updateSong: async input => {
      updates.push(input);
      return remoteSong({
        syncVersion: 2,
        syncDocuments: input.syncDocuments
      });
    }
  });
  const sync = synchronizer({ client, library, stateStore });
  await sync.sync();
  const conflict = await stateStore.getSongState(CONNECTION_ID, local.song.id);

  await assert.rejects(
    sync.resolveConflict(local.song.id, {
      strategy: 'keep-local',
      expectedSyncVersion: conflict.syncVersion,
      expectedLocalRevision: '0'.repeat(64)
    }),
    error => error.code === 'RESOLUTION_STALE'
  );
  const resolved = await sync.resolveConflict(local.song.id, {
    strategy: 'keep-local',
    expectedSyncVersion: conflict.syncVersion,
    expectedLocalRevision: conflict.conflict.localRevision
  });
  assert.equal(resolved.strategy, 'keep-local');
  assert.equal(updates.length, 1);
  assert.equal(updates[0].expectedSyncVersion, 1);
  assert.equal(updates[0].syncDocuments[0].revision, local.revision);
  assert.equal((await stateStore.getSongState(CONNECTION_ID, local.song.id)).conflict, null);
});

test('keep-remote conflict resolution imports guarded remote content without deleting local extras', async t => {
  const { library, stateStore } = await workspace(t);
  const local = await library.saveSource(songSource({ line: 'Local choice' }));
  const remoteSource = songSource({ line: 'Remote choice' });
  const remoteDocument = {
    id: local.song.id,
    source: remoteSource,
    revision: crypto.createHash('sha256').update(remoteSource).digest('hex')
  };
  const firstRemote = remoteSong({ syncDocuments: [remoteDocument] });
  const client = clientStub({
    listSongChanges: async () => ({
      items: [firstRemote],
      nextCursor: 'cursor-keep-remote',
      hasMore: false
    }),
    getSong: async () => firstRemote
  });
  const sync = synchronizer({ client, library, stateStore });
  await sync.sync();
  const conflict = await stateStore.getSongState(CONNECTION_ID, local.song.id);
  const resolved = await sync.resolveConflict(local.song.id, {
    strategy: 'keep-remote',
    expectedSyncVersion: conflict.syncVersion,
    expectedLocalRevision: conflict.conflict.localRevision
  });

  assert.equal(resolved.strategy, 'keep-remote');
  assert.match((await library.read(local.song.id)).source, /Remote choice/);
  assert.equal((await stateStore.getSongState(CONNECTION_ID, local.song.id)).conflict, null);
});
