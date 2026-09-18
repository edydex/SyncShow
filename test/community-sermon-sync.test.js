'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const {
  CommunitySermonSync,
  CommunitySermonSyncError
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

const CONNECTION_ID = 'connection-sermon-0001';
const ACCESS_TOKEN = 'community-sermon-access-token-000001';
const NOW = '2026-07-27T20:30:00.000Z';

async function tempDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'syncshow-community-sermon-sync-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return fs.realpath(directory);
}

function sermonDocument(id, title, {
  status = 'draft',
  sourceSha = 'a'.repeat(64)
} = {}) {
  return {
    schemaVersion: 2,
    kind: 'syncshow-sermon',
    id,
    titles: { en: title },
    defaultLanguage: 'en',
    speaker: { id: null, name: 'Pastor Example' },
    serviceDate: '2026-07-27',
    series: null,
    outline: [],
    sources: [{
      id: 'manuscript',
      kind: 'manuscript',
      fileName: `${id}.pdf`,
      mediaType: 'application/pdf',
      languages: ['en'],
      sha256: sourceSha,
      sizeBytes: 12345,
      provenance: {
        providedBy: 'Pastor Example',
        receivedAt: '2026-07-27T18:00:00.000Z',
        sourceSystem: 'manual-file-picker',
        externalId: ''
      }
    }],
    references: [],
    media: [],
    publication: {
      status,
      visibility: 'private',
      publishedAt: null,
      canonicalUrl: null
    }
  };
}

function sermonDocumentWithBody(id, title, text) {
  return {
    ...sermonDocument(id, title),
    schemaVersion: 3,
    body: [{
      id: 'reviewed-manuscript-en',
      kind: 'manuscript',
      language: 'en',
      sourceId: 'manuscript',
      sectionId: null,
      text
    }]
  };
}

function envelopeFor(document, {
  syncVersion = 1,
  updatedAt = NOW,
  sourceAvailable = false
} = {}) {
  const documentSource = serializeSermonDocument(document);
  return {
    syncId: document.id,
    syncVersion,
    revision: crypto.createHash('sha256').update(documentSource).digest('hex'),
    documentSource,
    archived: document.publication.status === 'archived',
    updatedAt,
    sourceObjects: document.sources.map(source => ({
      sourceId: source.id,
      sha256: source.sha256,
      sizeBytes: source.sizeBytes,
      available: sourceAvailable
    }))
  };
}

function summaryFor(envelope) {
  return {
    syncId: envelope.syncId,
    syncVersion: envelope.syncVersion,
    revision: envelope.revision,
    archived: envelope.archived,
    updatedAt: envelope.updatedAt
  };
}

function clientFor(remote, {
  cursor = 'sermon-cursor-1',
  create = null,
  update = null
} = {}) {
  const calls = {
    list: [],
    get: [],
    create: [],
    update: []
  };
  return {
    calls,
    listSermonChanges: async options => {
      calls.list.push(options);
      return {
        schemaVersion: 1,
        items: remote ? [summaryFor(remote)] : [],
        nextCursor: cursor,
        hasMore: false
      };
    },
    getSermon: async options => {
      calls.get.push(options);
      return remote;
    },
    createSermon: async options => {
      calls.create.push(options);
      if (create) return create(options);
      return remote;
    },
    updateSermon: async options => {
      calls.update.push(options);
      if (update) return update(options);
      return remote;
    }
  };
}

function syncEngine({ client, localLibrary, stateStore }) {
  return new CommunitySermonSync({
    client,
    localLibrary,
    stateStore,
    connectionId: CONNECTION_ID,
    accessTokenProvider: async () => ACCESS_TOKEN,
    now: () => new Date(NOW)
  });
}

async function stores(t) {
  const root = await tempDirectory(t);
  return {
    root,
    localLibrary: new LocalSermonLibrary({
      rootPath: path.join(root, 'sermons'),
      clock: () => new Date(NOW)
    }),
    stateStore: new CommunitySyncStateStore({
      storageRoot: path.join(root, 'state'),
      now: () => new Date(NOW)
    })
  };
}

test('pull hydrates only the exact remote ID and advances only the sermon cursor', async t => {
  const { localLibrary, stateStore } = await stores(t);
  const remote = envelopeFor(sermonDocument('sermon-remote', 'Shared title'));
  const similarlyNamed = await localLibrary.saveDocument(
    sermonDocument('sermon-local', 'Shared title'),
    { expectedRevision: null }
  );
  await stateStore.saveConnectionState(CONNECTION_ID, {
    cursor: 'song-cursor-keep',
    lastSyncAt: '2026-07-27T19:00:00.000Z',
    songs: {},
    sermonCursor: null,
    sermons: {}
  });
  const client = clientFor(remote);
  const result = await syncEngine({ client, localLibrary, stateStore }).pull();

  assert.equal(result.pulled, 1);
  assert.equal(result.conflicts, 0);
  assert.equal(result.cursor, 'sermon-cursor-1');
  assert.equal((await localLibrary.read('sermon-remote')).revision, remote.revision);
  assert.equal(
    (await localLibrary.read('sermon-local')).revision,
    similarlyNamed.revision,
    'title similarity must never bind or overwrite another sermon'
  );
  const state = await stateStore.getConnectionState(CONNECTION_ID);
  assert.equal(state.cursor, 'song-cursor-keep');
  assert.equal(state.sermonCursor, 'sermon-cursor-1');
  assert.equal(state.sermons['sermon-remote'].localSermonId, 'sermon-remote');
  assert.equal(state.sermons['sermon-remote'].localRevision, remote.revision);
  assert.equal(client.calls.get.length, 1, 'summary changes require a bounded full-envelope GET');
  assert.equal(client.calls.create.length, 0, 'pull must never upload local drafts');
  assert.equal(client.calls.update.length, 0, 'pull must never upload local drafts');
});

test('exact sermon pull uses one GET, preserves both feed cursors, and never lists or writes', async t => {
  const { localLibrary, stateStore } = await stores(t);
  const remote = envelopeFor(
    sermonDocument('planned-sermon', 'The exact planned sermon'),
    { syncVersion: 6 }
  );
  await stateStore.saveConnectionState(CONNECTION_ID, {
    cursor: 'keep-song-cursor',
    sermonCursor: 'keep-sermon-cursor',
    songs: {},
    sermons: {}
  });
  const client = clientFor(remote);
  client.listSermonChanges = async () => {
    client.calls.list.push({});
    throw new Error('exact sermon pull must not read the change feed');
  };

  const result = await syncEngine({
    client,
    localLibrary,
    stateStore
  }).pullSermon('planned-sermon', {
    expectedSyncVersion: 6,
    expectedRevision: remote.revision
  });

  assert.equal(result.pulled, 1);
  assert.equal(result.syncId, 'planned-sermon');
  assert.equal(client.calls.get.length, 1);
  assert.equal(client.calls.list.length, 0);
  assert.equal(client.calls.create.length, 0);
  assert.equal(client.calls.update.length, 0);
  assert.equal(
    (await localLibrary.read('planned-sermon')).revision,
    remote.revision
  );
  const state = await stateStore.getConnectionState(CONNECTION_ID);
  assert.equal(state.cursor, 'keep-song-cursor');
  assert.equal(state.sermonCursor, 'keep-sermon-cursor');
});

test('exact sermon pull rejects a changed remote pin before library or sync-state mutation', async t => {
  const { localLibrary, stateStore } = await stores(t);
  const remote = envelopeFor(
    sermonDocument('changed-planned-sermon', 'Changed sermon'),
    { syncVersion: 3 }
  );
  await stateStore.saveConnectionState(CONNECTION_ID, {
    cursor: 'song-cursor-before-mismatch',
    sermonCursor: 'sermon-cursor-before-mismatch',
    songs: {},
    sermons: {}
  });
  const client = clientFor(remote);
  client.listSermonChanges = async () => {
    client.calls.list.push({});
    throw new Error('exact sermon pull must not read the change feed');
  };

  await assert.rejects(
    syncEngine({
      client,
      localLibrary,
      stateStore
    }).pullSermon('changed-planned-sermon', {
      expectedSyncVersion: 2,
      expectedRevision: 'a'.repeat(64)
    }),
    error => error.code === 'REMOTE_PRECONDITION_FAILED'
  );
  await assert.rejects(
    localLibrary.read('changed-planned-sermon'),
    error => error.code === 'SERMON_NOT_FOUND'
  );
  const state = await stateStore.getConnectionState(CONNECTION_ID);
  assert.equal(state.cursor, 'song-cursor-before-mismatch');
  assert.equal(state.sermonCursor, 'sermon-cursor-before-mismatch');
  assert.deepEqual(Object.keys(state.sermons), []);
  assert.equal(client.calls.get.length, 1);
  assert.equal(client.calls.list.length, 0);
  assert.equal(client.calls.create.length, 0);
  assert.equal(client.calls.update.length, 0);
});

test('pull preserves the exact ordered v3 sermon body in the local canonical revision', async t => {
  const { localLibrary, stateStore } = await stores(t);
  const document = sermonDocumentWithBody(
    'sermon-v3-pull',
    'Reviewed sermon body',
    'Opening paragraph.\n\nReviewed concluding paragraph.'
  );
  document.sources.push({
    ...document.sources[0],
    id: 'slide-notes',
    kind: 'slide-notes',
    fileName: 'sermon-v3-pull-slides.pptx',
    mediaType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    sha256: 'b'.repeat(64)
  });
  document.body.push({
    id: 'reviewed-slide-notes-en',
    kind: 'slide-notes',
    language: 'en',
    sourceId: 'slide-notes',
    sectionId: null,
    text: 'Congregational slide notes remain a distinct ordered entry.'
  });
  const remote = envelopeFor(document);

  const result = await syncEngine({
    client: clientFor(remote),
    localLibrary,
    stateStore
  }).pull();

  assert.equal(result.pulled, 1);
  const current = await localLibrary.read(document.id);
  assert.equal(current.revision, remote.revision);
  assert.equal(current.source, remote.documentSource);
  assert.deepEqual(current.sermon.body, document.body);
});

test('pull processes full envelopes sequentially without retaining an unbounded envelope batch', async t => {
  const { localLibrary, stateStore } = await stores(t);
  const remotes = [
    envelopeFor(sermonDocument('sermon-sequential-1', 'First')),
    envelopeFor(sermonDocument('sermon-sequential-2', 'Second'))
  ];
  let activeGets = 0;
  let maximumActiveGets = 0;
  const client = clientFor(null);
  client.listSermonChanges = async () => ({
    schemaVersion: 1,
    items: remotes.map(summaryFor),
    nextCursor: 'sequential-final',
    hasMore: false
  });
  client.getSermon = async ({ syncId }) => {
    activeGets += 1;
    maximumActiveGets = Math.max(maximumActiveGets, activeGets);
    await new Promise(resolve => setImmediate(resolve));
    activeGets -= 1;
    return remotes.find(remote => remote.syncId === syncId);
  };

  const result = await syncEngine({ client, localLibrary, stateStore }).pull();
  assert.equal(result.pulled, 2);
  assert.equal(maximumActiveGets, 1);
  assert.equal((await localLibrary.read('sermon-sequential-1')).revision, remotes[0].revision);
  assert.equal((await localLibrary.read('sermon-sequential-2')).revision, remotes[1].revision);
});

test('an empty final poll may retain its durable cursor while continuing pages must advance', async t => {
  const { localLibrary, stateStore } = await stores(t);
  await stateStore.saveConnectionState(CONNECTION_ID, {
    songs: {},
    sermonCursor: 'stable-cursor',
    sermons: {}
  });
  const noChanges = clientFor(null, { cursor: 'stable-cursor' });
  const result = await syncEngine({
    client: noChanges,
    localLibrary,
    stateStore
  }).pull();
  assert.equal(result.cursor, 'stable-cursor');
  assert.equal(result.pulled, 0);

  const replayingFinal = clientFor(null);
  replayingFinal.listSermonChanges = async () => ({
    schemaVersion: 1,
    items: [summaryFor(envelopeFor(sermonDocument('sermon-replay', 'Replay')))],
    nextCursor: 'stable-cursor',
    hasMore: false
  });
  await assert.rejects(
    syncEngine({ client: replayingFinal, localLibrary, stateStore }).pull(),
    error => error.code === 'INVALID_REMOTE_CURSOR'
  );

  const continuing = clientFor(null);
  continuing.listSermonChanges = async () => ({
    schemaVersion: 1,
    items: [summaryFor(envelopeFor(sermonDocument('sermon-loop', 'Loop')))],
    nextCursor: 'stable-cursor',
    hasMore: true
  });
  await assert.rejects(
    syncEngine({ client: continuing, localLibrary, stateStore }).pull(),
    error => error.code === 'INVALID_REMOTE_CURSOR'
  );

  let page = 0;
  const cyclesToInitial = clientFor(null);
  cyclesToInitial.listSermonChanges = async () => {
    page += 1;
    return page === 1
      ? {
          schemaVersion: 1,
          items: [summaryFor(envelopeFor(sermonDocument('sermon-cycle', 'Cycle')))],
          nextCursor: 'middle-cursor',
          hasMore: true
        }
      : {
          schemaVersion: 1,
          items: [],
          nextCursor: 'stable-cursor',
          hasMore: false
        };
  };
  await assert.rejects(
    syncEngine({ client: cyclesToInitial, localLibrary, stateStore }).pull(),
    error => error.code === 'INVALID_REMOTE_CURSOR'
  );
});

test('retryable envelope failure keeps the cursor and safely checkpointed exact records', async t => {
  const { localLibrary, stateStore } = await stores(t);
  await stateStore.saveConnectionState(CONNECTION_ID, {
    songs: {},
    sermonCursor: 'before-partial',
    sermons: {}
  });
  const first = envelopeFor(sermonDocument('sermon-partial-1', 'First'));
  const second = envelopeFor(sermonDocument('sermon-partial-2', 'Second'));
  const client = clientFor(null);
  client.listSermonChanges = async () => ({
    schemaVersion: 1,
    items: [summaryFor(first), summaryFor(second)],
    nextCursor: 'after-partial',
    hasMore: false
  });
  client.getSermon = async ({ syncId }) => {
    if (syncId === first.syncId) return first;
    const error = new Error('offline');
    error.code = 'NETWORK_ERROR';
    error.retryable = true;
    throw error;
  };

  const result = await syncEngine({ client, localLibrary, stateStore }).pull();
  assert.equal(result.status, 'offline');
  assert.equal(result.pulled, 1);
  assert.equal(result.cursor, 'before-partial');
  assert.equal((await localLibrary.read(first.syncId)).revision, first.revision);
  await assert.rejects(
    localLibrary.read(second.syncId),
    error => error.code === 'SERMON_NOT_FOUND'
  );
  const state = await stateStore.getConnectionState(CONNECTION_ID);
  assert.equal(state.sermonCursor, 'before-partial');
  assert.equal(state.sermons[first.syncId].localRevision, first.revision);
});

test('pull fast-forwards an unchanged baseline by CAS and retains immutable history', async t => {
  const { localLibrary, stateStore } = await stores(t);
  const id = 'sermon-fast-forward';
  const original = await localLibrary.saveDocument(
    sermonDocument(id, 'Original title'),
    { expectedRevision: null }
  );
  await stateStore.saveConnectionState(CONNECTION_ID, {
    songs: {},
    sermonCursor: null,
    sermons: {
      [id]: {
        syncId: id,
        localSermonId: id,
        syncVersion: 1,
        localRevision: original.revision,
        remoteRevision: original.revision,
        lastSyncedAt: '2026-07-27T19:00:00.000Z'
      }
    }
  });
  const remote = envelopeFor(
    sermonDocument(id, 'Archived canonical revision', { status: 'archived' }),
    { syncVersion: 2 }
  );
  const result = await syncEngine({
    client: clientFor(remote),
    localLibrary,
    stateStore
  }).pull();

  assert.equal(result.pulled, 1);
  const current = await localLibrary.read(id);
  assert.equal(current.revision, remote.revision);
  assert.equal(current.sermon.publication.status, 'archived');
  assert.equal(
    (await localLibrary.readRevision(id, original.revision)).sermon.titles.en,
    'Original title',
    'fast-forward must not discard the prior immutable revision'
  );
  const state = await stateStore.getSermonState(CONNECTION_ID, id);
  assert.equal(state.localRevision, remote.revision);
  assert.equal(state.remoteRevision, remote.revision);
  assert.equal(state.syncVersion, 2);
  assert.equal(state.conflict, null);
});

test('pull rejects syncVersion rollback and same-version revision reuse', async t => {
  const { localLibrary, stateStore } = await stores(t);
  const cases = [
    {
      id: 'sermon-version-regression',
      priorVersion: 2,
      remoteVersion: 1,
      remoteTitle: 'Changed after rollback',
      code: 'REMOTE_SYNC_VERSION_REGRESSION'
    },
    {
      id: 'sermon-version-reuse',
      priorVersion: 2,
      remoteVersion: 2,
      remoteTitle: 'Changed under reused version',
      code: 'REMOTE_SYNC_VERSION_REUSED'
    }
  ];

  for (const item of cases) {
    const baseline = await localLibrary.saveDocument(
      sermonDocument(item.id, 'Baseline'),
      { expectedRevision: null }
    );
    const state = await stateStore.getConnectionState(CONNECTION_ID);
    state.sermons[item.id] = {
      syncId: item.id,
      localSermonId: item.id,
      syncVersion: item.priorVersion,
      localRevision: baseline.revision,
      remoteRevision: baseline.revision
    };
    await stateStore.saveConnectionState(CONNECTION_ID, state);
    const remote = envelopeFor(
      item.remoteTitle === null
        ? baseline.sermon
        : sermonDocument(item.id, item.remoteTitle),
      { syncVersion: item.remoteVersion }
    );
    await assert.rejects(
      syncEngine({
        client: clientFor(remote, { cursor: `cursor-${item.id}` }),
        localLibrary,
        stateStore
      }).pull(),
      error => error.code === item.code
    );
    assert.equal((await localLibrary.read(item.id)).revision, baseline.revision);
  }
});

test('a higher syncVersion may return to a previously observed canonical revision', async t => {
  const { localLibrary, stateStore } = await stores(t);
  const id = 'sermon-version-revert';
  const baseline = await localLibrary.saveDocument(
    sermonDocument(id, 'Baseline'),
    { expectedRevision: null }
  );
  await stateStore.saveConnectionState(CONNECTION_ID, {
    songs: {},
    sermonCursor: null,
    sermons: {
      [id]: {
        syncId: id,
        localSermonId: id,
        syncVersion: 2,
        localRevision: baseline.revision,
        remoteRevision: baseline.revision
      }
    }
  });

  const remote = envelopeFor(baseline.sermon, { syncVersion: 3 });
  const result = await syncEngine({
    client: clientFor(remote, { cursor: 'cursor-sermon-version-revert' }),
    localLibrary,
    stateStore
  }).pull();

  assert.equal(result.pulled, 0);
  const savedState = await stateStore.getSermonState(CONNECTION_ID, id);
  assert.equal(savedState.syncVersion, 3);
  assert.equal(savedState.remoteRevision, baseline.revision);
  assert.equal((await localLibrary.read(id)).revision, baseline.revision);
});

test('divergent local and remote revisions preserve both and record a bounded conflict', async t => {
  const { localLibrary, stateStore } = await stores(t);
  const id = 'sermon-diverged';
  const baseline = await localLibrary.saveDocument(
    sermonDocument(id, 'Baseline'),
    { expectedRevision: null }
  );
  await stateStore.saveConnectionState(CONNECTION_ID, {
    songs: {},
    sermonCursor: null,
    sermons: {
      [id]: {
        syncId: id,
        localSermonId: id,
        syncVersion: 1,
        localRevision: baseline.revision,
        remoteRevision: baseline.revision
      }
    }
  });
  const local = await localLibrary.saveDocument(sermonDocument(id, 'Local edit'), {
    expectedSermonId: id,
    expectedRevision: baseline.revision
  });
  const remote = envelopeFor(sermonDocument(id, 'Community edit'), {
    syncVersion: 2
  });

  const result = await syncEngine({
    client: clientFor(remote),
    localLibrary,
    stateStore
  }).pull();
  assert.equal(result.conflicts, 1);
  assert.equal((await localLibrary.read(id)).revision, local.revision);
  assert.equal(
    (await localLibrary.readRevision(id, remote.revision)).revision,
    remote.revision,
    'the remote revision is staged in immutable history without promotion'
  );
  const state = await stateStore.getSermonState(CONNECTION_ID, id);
  assert.equal(state.conflict.code, 'BOTH_CHANGED');
  assert.equal(state.conflict.localRevision, local.revision);
  assert.equal(state.conflict.lastSyncedLocalRevision, baseline.revision);
  assert.equal(state.conflict.remoteRevision, remote.revision);
  assert.equal(
    Object.prototype.hasOwnProperty.call(state.conflict, 'remoteDocumentSource'),
    false,
    'large canonical sources belong in immutable sermon history, not sync state'
  );
  assert.equal(state.localRevision, baseline.revision);
});

test('body-only local and Community edits preserve both v3 revisions as a conflict', async t => {
  const { localLibrary, stateStore } = await stores(t);
  const id = 'sermon-v3-body-diverged';
  const baselineDocument = sermonDocumentWithBody(
    id,
    'Stable metadata',
    'Shared reviewed baseline body.'
  );
  const baseline = await localLibrary.saveDocument(baselineDocument, {
    expectedRevision: null
  });
  await stateStore.saveConnectionState(CONNECTION_ID, {
    songs: {},
    sermonCursor: null,
    sermons: {
      [id]: {
        syncId: id,
        localSermonId: id,
        syncVersion: 1,
        localRevision: baseline.revision,
        remoteRevision: baseline.revision,
        lastSyncedAt: '2026-07-27T19:00:00.000Z'
      }
    }
  });

  const localDocument = sermonDocumentWithBody(
    id,
    'Stable metadata',
    'Locally reviewed body wording.'
  );
  const local = await localLibrary.saveDocument(localDocument, {
    expectedSermonId: id,
    expectedRevision: baseline.revision
  });
  const remoteDocument = sermonDocumentWithBody(
    id,
    'Stable metadata',
    'Community reviewed body wording.'
  );
  const remote = envelopeFor(remoteDocument, { syncVersion: 2 });

  const result = await syncEngine({
    client: clientFor(remote),
    localLibrary,
    stateStore
  }).pull();

  assert.equal(result.conflicts, 1);
  assert.deepEqual((await localLibrary.read(id)).sermon.body, localDocument.body);
  assert.deepEqual(
    (await localLibrary.readRevision(id, remote.revision)).sermon.body,
    remoteDocument.body
  );
  const state = await stateStore.getSermonState(CONNECTION_ID, id);
  assert.equal(state.conflict.code, 'BOTH_CHANGED');
  assert.equal(state.conflict.localRevision, local.revision);
  assert.equal(state.conflict.remoteRevision, remote.revision);
});

test('conflict staging retries one local CAS race and records the actual current revision', async t => {
  const { localLibrary, stateStore } = await stores(t);
  const id = 'sermon-conflict-stage-race';
  const baseline = await localLibrary.saveDocument(
    sermonDocument(id, 'Baseline'),
    { expectedRevision: null }
  );
  await stateStore.saveConnectionState(CONNECTION_ID, {
    songs: {},
    sermons: {
      [id]: {
        syncId: id,
        localSermonId: id,
        syncVersion: 1,
        localRevision: baseline.revision,
        remoteRevision: baseline.revision
      }
    }
  });
  const openedLocal = await localLibrary.saveDocument(
    sermonDocument(id, 'First local edit'),
    {
      expectedSermonId: id,
      expectedRevision: baseline.revision
    }
  );
  const remote = envelopeFor(sermonDocument(id, 'Community edit'), {
    syncVersion: 2
  });
  let stageAttempts = 0;
  let concurrentLocal = null;
  const racingLibrary = {
    read: (...args) => localLibrary.read(...args),
    readRevision: (...args) => localLibrary.readRevision(...args),
    validateSource: (...args) => localLibrary.validateSource(...args),
    saveSource: (...args) => localLibrary.saveSource(...args),
    stageSource: async (source, options) => {
      stageAttempts += 1;
      if (stageAttempts === 1) {
        concurrentLocal = await localLibrary.saveDocument(
          sermonDocument(id, 'Concurrent local edit'),
          {
            expectedSermonId: id,
            expectedRevision: openedLocal.revision
          }
        );
        const error = new Error('simulated local pointer race');
        error.code = 'SERMON_CONFLICT';
        throw error;
      }
      assert.equal(options.expectedRevision, concurrentLocal.revision);
      return localLibrary.stageSource(source, options);
    }
  };

  const result = await syncEngine({
    client: clientFor(remote),
    localLibrary: racingLibrary,
    stateStore
  }).pull();

  assert.equal(result.conflicts, 1);
  assert.equal(stageAttempts, 2);
  assert.equal((await localLibrary.read(id)).revision, concurrentLocal.revision);
  assert.equal((await localLibrary.readRevision(id, remote.revision)).revision, remote.revision);
  const state = await stateStore.getSermonState(CONNECTION_ID, id);
  assert.equal(state.conflict.localRevision, concurrentLocal.revision);
  assert.equal(state.conflict.remoteRevision, remote.revision);
});

test('keep-remote resolves from the saved canonical source by local CAS without a network write', async t => {
  const { localLibrary, stateStore } = await stores(t);
  const id = 'sermon-resolve-keep-remote';
  const baseline = await localLibrary.saveDocument(
    sermonDocument(id, 'Baseline'),
    { expectedRevision: null }
  );
  await stateStore.saveConnectionState(CONNECTION_ID, {
    songs: {},
    sermons: {
      [id]: {
        syncId: id,
        localSermonId: id,
        syncVersion: 1,
        localRevision: baseline.revision,
        remoteRevision: baseline.revision
      }
    }
  });
  const local = await localLibrary.saveDocument(sermonDocument(id, 'Local choice'), {
    expectedSermonId: id,
    expectedRevision: baseline.revision
  });
  const remote = envelopeFor(sermonDocument(id, 'Community choice'), {
    syncVersion: 2
  });
  const client = clientFor(remote);
  const engine = syncEngine({ client, localLibrary, stateStore });
  await engine.pull();
  const conflict = await stateStore.getSermonState(CONNECTION_ID, id);
  const networkCallsBeforeResolution = {
    get: client.calls.get.length,
    create: client.calls.create.length,
    update: client.calls.update.length
  };

  const resolved = await engine.resolveConflict(id, {
    strategy: 'keep-remote',
    expectedSyncVersion: conflict.syncVersion,
    expectedLocalRevision: conflict.conflict.localRevision
  });

  assert.equal(resolved.resolved, true);
  assert.equal(resolved.strategy, 'keep-remote');
  assert.equal(resolved.revision, remote.revision);
  assert.equal(Object.isFrozen(resolved), true);
  assert.equal(Object.isFrozen(resolved.warnings), true);
  assert.deepEqual({
    get: client.calls.get.length,
    create: client.calls.create.length,
    update: client.calls.update.length
  }, networkCallsBeforeResolution, 'keeping the saved Community copy must not write or re-fetch');
  assert.equal((await localLibrary.read(id)).revision, remote.revision);
  assert.equal(
    (await localLibrary.readRevision(id, local.revision)).sermon.titles.en,
    'Local choice',
    'the displaced local revision remains in immutable history'
  );
  const state = await stateStore.getSermonState(CONNECTION_ID, id);
  assert.equal(state.conflict, null);
  assert.equal(state.syncVersion, 2);
  assert.equal(state.localRevision, remote.revision);
  assert.equal(state.remoteRevision, remote.revision);
  assert.equal(state.lastSyncedAt, NOW);
  assert.equal(
    (await stateStore.getConnectionState(CONNECTION_ID)).lastSermonSyncAt,
    NOW
  );
});

test('keep-local fetches the exact saved server version then CAS-writes only the reviewed source', async t => {
  const { localLibrary, stateStore } = await stores(t);
  const id = 'sermon-resolve-keep-local';
  const baseline = await localLibrary.saveDocument(
    sermonDocument(id, 'Baseline'),
    { expectedRevision: null }
  );
  await stateStore.saveConnectionState(CONNECTION_ID, {
    songs: {},
    sermons: {
      [id]: {
        syncId: id,
        localSermonId: id,
        syncVersion: 1,
        localRevision: baseline.revision,
        remoteRevision: baseline.revision
      }
    }
  });
  const local = await localLibrary.saveDocument(sermonDocument(id, 'Reviewed local choice'), {
    expectedSermonId: id,
    expectedRevision: baseline.revision
  });
  const remote = envelopeFor(sermonDocument(id, 'Community choice'), {
    syncVersion: 2
  });
  const accepted = envelopeFor(local.sermon, { syncVersion: 3 });
  const client = clientFor(remote, {
    update: options => {
      assert.equal(options.syncId, id);
      assert.equal(options.documentSource, local.documentSource);
      assert.equal(options.expectedSyncVersion, 2);
      return accepted;
    }
  });
  const engine = syncEngine({ client, localLibrary, stateStore });
  await engine.pull();
  const conflict = await stateStore.getSermonState(CONNECTION_ID, id);
  const getsBeforeResolution = client.calls.get.length;

  const resolved = await engine.resolveConflict(id, {
    strategy: 'keep-local',
    expectedSyncVersion: conflict.syncVersion,
    expectedLocalRevision: conflict.conflict.localRevision
  });

  assert.equal(resolved.resolved, true);
  assert.equal(resolved.strategy, 'keep-local');
  assert.equal(resolved.revision, local.revision);
  assert.equal(resolved.syncVersion, 3);
  assert.equal(client.calls.get.length, getsBeforeResolution + 1);
  assert.equal(client.calls.update.length, 1);
  assert.equal(client.calls.create.length, 0);
  assert.equal((await localLibrary.read(id)).revision, local.revision);
  assert.equal(
    (await localLibrary.readRevision(id, remote.revision)).revision,
    remote.revision,
    'the rejected Community revision remains in immutable history'
  );
  const state = await stateStore.getSermonState(CONNECTION_ID, id);
  assert.equal(state.conflict, null);
  assert.equal(state.syncVersion, 3);
  assert.equal(state.localRevision, local.revision);
  assert.equal(state.remoteRevision, local.revision);
  assert.equal(state.lastSyncedAt, NOW);
});

test('conflict resolution rejects stale saved or local expectations before network activity', async t => {
  const { localLibrary, stateStore } = await stores(t);
  const id = 'sermon-resolve-stale-local';
  const baseline = await localLibrary.saveDocument(
    sermonDocument(id, 'Baseline'),
    { expectedRevision: null }
  );
  await stateStore.saveConnectionState(CONNECTION_ID, {
    songs: {},
    sermons: {
      [id]: {
        syncId: id,
        localSermonId: id,
        syncVersion: 1,
        localRevision: baseline.revision,
        remoteRevision: baseline.revision
      }
    }
  });
  const local = await localLibrary.saveDocument(sermonDocument(id, 'First local edit'), {
    expectedSermonId: id,
    expectedRevision: baseline.revision
  });
  const remote = envelopeFor(sermonDocument(id, 'Community edit'), {
    syncVersion: 2
  });
  const client = clientFor(remote);
  const engine = syncEngine({ client, localLibrary, stateStore });
  await engine.pull();
  const conflict = await stateStore.getSermonState(CONNECTION_ID, id);
  const callsBefore = client.calls.get.length;

  await assert.rejects(
    engine.resolveConflict(id, {
      strategy: 'keep-local',
      expectedSyncVersion: 3,
      expectedLocalRevision: conflict.conflict.localRevision
    }),
    error => error.code === 'RESOLUTION_STALE'
  );
  await assert.rejects(
    engine.resolveConflict(id, {
      strategy: 'keep-local',
      expectedSyncVersion: conflict.syncVersion,
      expectedLocalRevision: '0'.repeat(64)
    }),
    error => error.code === 'RESOLUTION_STALE'
  );

  const changed = await localLibrary.saveDocument(
    sermonDocument(id, 'Changed after review opened'),
    {
      expectedSermonId: id,
      expectedRevision: local.revision
    }
  );
  await assert.rejects(
    engine.resolveConflict(id, {
      strategy: 'keep-local',
      expectedSyncVersion: conflict.syncVersion,
      expectedLocalRevision: conflict.conflict.localRevision
    }),
    error => error.code === 'RESOLUTION_STALE'
      && error.details.currentLocalRevision === changed.revision
  );
  assert.equal(client.calls.get.length, callsBefore);
  assert.equal(client.calls.update.length, 0);
  assert.equal(client.calls.create.length, 0);
  assert.equal(
    (await stateStore.getSermonState(CONNECTION_ID, id)).conflict.remoteRevision,
    remote.revision
  );

  const reopened = await engine.resolveConflict(id, {
    strategy: 'keep-remote',
    expectedSyncVersion: conflict.syncVersion,
    expectedLocalRevision: changed.revision
  });
  assert.equal(reopened.resolved, true);
  assert.equal(reopened.revision, remote.revision);
  assert.equal((await localLibrary.read(id)).revision, remote.revision);
});

test('a newer preflight server revision updates the conflict without a stale PUT', async t => {
  const { localLibrary, stateStore } = await stores(t);
  const id = 'sermon-resolve-server-moved';
  const baseline = await localLibrary.saveDocument(
    sermonDocument(id, 'Baseline'),
    { expectedRevision: null }
  );
  await stateStore.saveConnectionState(CONNECTION_ID, {
    songs: {},
    sermons: {
      [id]: {
        syncId: id,
        localSermonId: id,
        syncVersion: 1,
        localRevision: baseline.revision,
        remoteRevision: baseline.revision
      }
    }
  });
  const local = await localLibrary.saveDocument(sermonDocument(id, 'Local choice'), {
    expectedSermonId: id,
    expectedRevision: baseline.revision
  });
  let remote = envelopeFor(sermonDocument(id, 'First Community choice'), {
    syncVersion: 2
  });
  const client = clientFor(remote);
  const engine = syncEngine({ client, localLibrary, stateStore });
  await engine.pull();
  const conflict = await stateStore.getSermonState(CONNECTION_ID, id);
  remote = envelopeFor(sermonDocument(id, 'Newer Community choice'), {
    syncVersion: 3
  });
  client.getSermon = async options => {
    client.calls.get.push(options);
    return remote;
  };

  const result = await engine.resolveConflict(id, {
    strategy: 'keep-local',
    expectedSyncVersion: conflict.syncVersion,
    expectedLocalRevision: conflict.conflict.localRevision
  });

  assert.equal(result.resolved, false);
  assert.equal(result.status, 'conflict');
  assert.equal(result.syncVersion, 3);
  assert.equal(client.calls.update.length, 0, 'a stale reviewed version must never be PUT');
  assert.equal((await localLibrary.read(id)).revision, local.revision);
  const state = await stateStore.getSermonState(CONNECTION_ID, id);
  assert.equal(state.conflict.code, 'RESOLUTION_REMOTE_CHANGED');
  assert.equal(state.conflict.remoteSyncVersion, 3);
  assert.equal(state.conflict.remoteRevision, remote.revision);
  assert.equal((await localLibrary.readRevision(id, remote.revision)).revision, remote.revision);
  assert.equal(state.localRevision, baseline.revision);
});

test('a server CAS race refreshes and preserves the conflict without overwriting local work', async t => {
  const { localLibrary, stateStore } = await stores(t);
  const id = 'sermon-resolve-server-race';
  const baseline = await localLibrary.saveDocument(
    sermonDocument(id, 'Baseline'),
    { expectedRevision: null }
  );
  await stateStore.saveConnectionState(CONNECTION_ID, {
    songs: {},
    sermons: {
      [id]: {
        syncId: id,
        localSermonId: id,
        syncVersion: 1,
        localRevision: baseline.revision,
        remoteRevision: baseline.revision
      }
    }
  });
  const local = await localLibrary.saveDocument(sermonDocument(id, 'Local choice'), {
    expectedSermonId: id,
    expectedRevision: baseline.revision
  });
  const reviewedRemote = envelopeFor(sermonDocument(id, 'Reviewed Community choice'), {
    syncVersion: 2
  });
  const racedRemote = envelopeFor(sermonDocument(id, 'Concurrent Community edit'), {
    syncVersion: 3
  });
  let resolvingGet = 0;
  const client = clientFor(reviewedRemote, {
    update: options => {
      assert.equal(options.documentSource, local.documentSource);
      assert.equal(options.expectedSyncVersion, 2);
      const error = new Error('Community changed during the PUT');
      error.code = 'REVISION_CONFLICT';
      throw error;
    }
  });
  const engine = syncEngine({ client, localLibrary, stateStore });
  await engine.pull();
  const conflict = await stateStore.getSermonState(CONNECTION_ID, id);
  client.getSermon = async options => {
    client.calls.get.push(options);
    resolvingGet += 1;
    return resolvingGet === 1 ? reviewedRemote : racedRemote;
  };

  const result = await engine.resolveConflict(id, {
    strategy: 'keep-local',
    expectedSyncVersion: conflict.syncVersion,
    expectedLocalRevision: conflict.conflict.localRevision
  });

  assert.equal(result.resolved, false);
  assert.equal(result.status, 'conflict');
  assert.equal(result.syncVersion, 3);
  assert.equal(client.calls.update.length, 1);
  assert.equal(client.calls.create.length, 0);
  assert.equal((await localLibrary.read(id)).revision, local.revision);
  const state = await stateStore.getSermonState(CONNECTION_ID, id);
  assert.equal(state.conflict.code, 'RESOLUTION_REMOTE_RACE');
  assert.equal(state.conflict.localRevision, local.revision);
  assert.equal(state.conflict.remoteRevision, racedRemote.revision);
  assert.equal(state.conflict.remoteSyncVersion, 3);
  assert.equal(
    (await localLibrary.readRevision(id, racedRemote.revision)).revision,
    racedRemote.revision
  );
});

test('multiple near-limit conflict sources normalize to compact metadata-only state', async t => {
  const { stateStore } = await stores(t);
  const nearLegacyLimit = 'x'.repeat((2 * 1024 * 1024) - 1024);
  const sermons = {};
  for (let index = 0; index < 4; index += 1) {
    const id = `sermon-compact-conflict-${index}`;
    sermons[id] = {
      syncId: id,
      localSermonId: id,
      syncVersion: index + 1,
      localRevision: 'a'.repeat(64),
      remoteRevision: String(index + 1).repeat(64),
      conflict: {
        code: 'BOTH_CHANGED',
        detectedAt: NOW,
        localRevision: 'a'.repeat(64),
        lastSyncedLocalRevision: 'b'.repeat(64),
        remoteRevision: String(index + 1).repeat(64),
        remoteSyncVersion: index + 1,
        remoteDocumentSource: nearLegacyLimit
      }
    };
  }
  const saved = await stateStore.saveConnectionState(CONNECTION_ID, {
    songs: {
      keep: {
        syncId: 'keep',
        syncVersion: 1,
        remoteRevision: 'song:keep:1',
        documents: {},
        visibility: 'private'
      }
    },
    sermons
  });

  for (const sermon of Object.values(saved.sermons)) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(sermon.conflict, 'remoteDocumentSource'),
      false
    );
  }
  assert.ok(
    (await fs.stat(stateStore.storePath)).size < 64 * 1024,
    'four conflicts remain compact instead of consuming the aggregate 16 MiB store'
  );
  assert.equal(saved.songs.keep.syncId, 'keep');
});

test('push is an explicit one-sermon create/update and archive stays in canonical source', async t => {
  const { localLibrary, stateStore } = await stores(t);
  const id = 'sermon-explicit-push';
  let local = await localLibrary.saveDocument(
    sermonDocument(id, 'Draft to upload'),
    { expectedRevision: null }
  );
  await localLibrary.saveDocument(
    sermonDocument('another-local-draft', 'Must stay local'),
    { expectedRevision: null }
  );

  let remote = envelopeFor(local.sermon, { syncVersion: 1 });
  const client = clientFor(null, {
    create: options => {
      assert.equal(options.syncId, id);
      assert.equal(options.documentSource, local.documentSource);
      assert.match(options.idempotencyKey, /^[a-f0-9]{64}$/);
      return remote;
    },
    update: options => {
      assert.equal(options.syncId, id);
      assert.equal(options.expectedSyncVersion, 1);
      assert.equal(
        JSON.parse(options.documentSource).publication.status,
        'archived',
        'archive is a canonical document update, not a DELETE'
      );
      return remote;
    }
  });
  client.getSermon = async options => {
    client.calls.get.push(options);
    return remote;
  };

  const engine = syncEngine({ client, localLibrary, stateStore });
  const created = await engine.pushSermon(id, {
    expectedLocalRevision: local.revision
  });
  assert.equal(created.operation, 'created');
  assert.equal(client.calls.create.length, 1);
  assert.equal(client.calls.update.length, 0);

  const archivedDocument = JSON.parse(local.documentSource);
  archivedDocument.publication.status = 'archived';
  local = await localLibrary.saveDocument(archivedDocument, {
    expectedSermonId: id,
    expectedRevision: local.revision
  });
  remote = envelopeFor(local.sermon, { syncVersion: 2 });
  const updated = await engine.pushSermon(id, {
    expectedSyncVersion: 1,
    expectedLocalRevision: local.revision
  });

  assert.equal(updated.operation, 'updated');
  assert.equal(client.calls.create.length, 1);
  assert.equal(client.calls.update.length, 1);
  assert.equal(client.calls.list.length, 0, 'explicit push must not scan the remote feed');
  assert.equal((await localLibrary.read('another-local-draft')).sermon.id, 'another-local-draft');
  const state = await stateStore.getSermonState(CONNECTION_ID, id);
  assert.equal(state.syncVersion, 2);
  assert.equal(state.localRevision, local.revision);
});

test('push rejects a stale expected local revision before any network write', async t => {
  const { localLibrary, stateStore } = await stores(t);
  const id = 'sermon-local-race';
  const opened = await localLibrary.saveDocument(
    sermonDocument(id, 'Reviewed revision'),
    { expectedRevision: null }
  );
  const current = await localLibrary.saveDocument(
    sermonDocument(id, 'Changed after the share dialog opened'),
    {
      expectedSermonId: id,
      expectedRevision: opened.revision
    }
  );
  const client = clientFor(null);

  await assert.rejects(
    syncEngine({ client, localLibrary, stateStore }).pushSermon(id, {
      expectedSyncVersion: null,
      expectedLocalRevision: opened.revision
    }),
    error => error.code === 'LOCAL_REVISION_CONFLICT'
      && error.details.expectedLocalRevision === opened.revision
      && error.details.currentLocalRevision === current.revision
  );
  assert.equal(client.calls.create.length, 0);
  assert.equal(client.calls.update.length, 0);
  assert.equal(client.calls.get.length, 0);
});

test('an unchanged push checkpoint GETs Community and preserves a newly advanced remote conflict', async t => {
  const { localLibrary, stateStore } = await stores(t);
  const id = 'sermon-unchanged-checkpoint-race';
  const local = await localLibrary.saveDocument(
    sermonDocument(id, 'Locally unchanged baseline'),
    { expectedRevision: null }
  );
  await stateStore.saveConnectionState(CONNECTION_ID, {
    songs: {},
    sermons: {
      [id]: {
        syncId: id,
        localSermonId: id,
        syncVersion: 1,
        localRevision: local.revision,
        remoteRevision: local.revision
      }
    }
  });
  const advancedRemote = envelopeFor(
    sermonDocument(id, 'Another client advanced Community'),
    { syncVersion: 2 }
  );
  const client = clientFor(advancedRemote);

  const result = await syncEngine({ client, localLibrary, stateStore })
    .pushSermon(id, {
      expectedSyncVersion: 1,
      expectedLocalRevision: local.revision
    });

  assert.equal(result.status, 'conflict');
  assert.equal(result.operation, 'conflict');
  assert.equal(client.calls.get.length, 1);
  assert.equal(client.calls.update.length, 0);
  assert.equal(client.calls.create.length, 0);
  assert.equal((await localLibrary.read(id)).revision, local.revision);
  assert.equal(
    (await localLibrary.readRevision(id, advancedRemote.revision)).revision,
    advancedRemote.revision
  );
  const state = await stateStore.getSermonState(CONNECTION_ID, id);
  assert.equal(state.syncVersion, 2);
  assert.equal(state.conflict.code, 'REMOTE_CAS_CONFLICT');
  assert.equal(state.conflict.localRevision, local.revision);
  assert.equal(state.conflict.remoteRevision, advancedRemote.revision);
});

test('a remote CAS conflict preserves a genuinely different server revision', async t => {
  const { localLibrary, stateStore } = await stores(t);
  const id = 'sermon-push-conflict';
  const baseline = await localLibrary.saveDocument(
    sermonDocument(id, 'Baseline'),
    { expectedRevision: null }
  );
  await stateStore.saveConnectionState(CONNECTION_ID, {
    songs: {},
    sermons: {
      [id]: {
        syncId: id,
        localSermonId: id,
        syncVersion: 1,
        localRevision: baseline.revision,
        remoteRevision: baseline.revision
      }
    }
  });
  const local = await localLibrary.saveDocument(sermonDocument(id, 'Local change'), {
    expectedSermonId: id,
    expectedRevision: baseline.revision
  });
  const remote = envelopeFor(sermonDocument(id, 'Remote change'), {
    syncVersion: 2
  });
  const client = clientFor(remote, {
    update: async () => {
      const error = new Error('stale');
      error.code = 'REVISION_CONFLICT';
      throw error;
    }
  });

  const result = await syncEngine({ client, localLibrary, stateStore })
    .pushSermon(id, {
      expectedSyncVersion: 1,
      expectedLocalRevision: local.revision
    });
  assert.equal(result.status, 'conflict');
  assert.equal(result.operation, 'conflict');
  assert.equal((await localLibrary.read(id)).revision, local.revision);
  assert.equal((await localLibrary.readRevision(id, remote.revision)).revision, remote.revision);
  const state = await stateStore.getSermonState(CONNECTION_ID, id);
  assert.equal(state.conflict.code, 'REMOTE_CAS_CONFLICT');
  assert.equal((await localLibrary.readRevision(id, remote.revision)).revision, remote.revision);
});

test('write adoption rejects a server that reuses its CAS version for new content', async t => {
  const { localLibrary, stateStore } = await stores(t);
  const id = 'sermon-write-version-reuse';
  const baseline = await localLibrary.saveDocument(
    sermonDocument(id, 'Baseline'),
    { expectedRevision: null }
  );
  await stateStore.saveConnectionState(CONNECTION_ID, {
    songs: {},
    sermons: {
      [id]: {
        syncId: id,
        localSermonId: id,
        syncVersion: 2,
        localRevision: baseline.revision,
        remoteRevision: baseline.revision
      }
    }
  });
  const local = await localLibrary.saveDocument(sermonDocument(id, 'Local update'), {
    expectedSermonId: id,
    expectedRevision: baseline.revision
  });
  const invalidResponse = envelopeFor(local.sermon, { syncVersion: 2 });

  await assert.rejects(
    syncEngine({
      client: clientFor(null, { update: () => invalidResponse }),
      localLibrary,
      stateStore
    }).pushSermon(id, {
      expectedSyncVersion: 2,
      expectedLocalRevision: local.revision
    }),
    error => error.code === 'REMOTE_SYNC_VERSION_REUSED'
  );
  const state = await stateStore.getSermonState(CONNECTION_ID, id);
  assert.equal(state.syncVersion, 2);
  assert.equal(state.localRevision, baseline.revision);
  assert.equal(state.remoteRevision, baseline.revision);
  assert.equal(state.conflict, null);
});

test('a lost local pull checkpoint retries as an exact adoption, not a false conflict', async t => {
  const { localLibrary, stateStore: durableStateStore } = await stores(t);
  const id = 'sermon-pull-lost-checkpoint';
  const baseline = await localLibrary.saveDocument(
    sermonDocument(id, 'Baseline'),
    { expectedRevision: null }
  );
  await durableStateStore.saveConnectionState(CONNECTION_ID, {
    songs: {},
    sermonCursor: null,
    sermons: {
      [id]: {
        syncId: id,
        localSermonId: id,
        syncVersion: 1,
        localRevision: baseline.revision,
        remoteRevision: baseline.revision
      }
    }
  });
  const remote = envelopeFor(sermonDocument(id, 'Remote fast-forward'), {
    syncVersion: 2
  });
  let failCheckpoint = true;
  const flakyStateStore = {
    getConnectionState: (...args) => durableStateStore.getConnectionState(...args),
    saveConnectionState: (...args) => {
      if (failCheckpoint) {
        failCheckpoint = false;
        const error = new Error('simulated checkpoint failure');
        error.code = 'STORE_WRITE_FAILED';
        throw error;
      }
      return durableStateStore.saveConnectionState(...args);
    }
  };
  const engine = syncEngine({
    client: clientFor(remote),
    localLibrary,
    stateStore: flakyStateStore
  });

  await assert.rejects(engine.pull(), error => error.code === 'STORE_WRITE_FAILED');
  assert.equal(
    (await localLibrary.read(id)).revision,
    remote.revision,
    'the local CAS committed before its state checkpoint failed'
  );
  const retried = await engine.pull();
  assert.equal(retried.conflicts, 0);
  assert.equal(retried.unchanged, 1);
  const state = await durableStateStore.getSermonState(CONNECTION_ID, id);
  assert.equal(state.localRevision, remote.revision);
  assert.equal(state.remoteRevision, remote.revision);
  assert.equal(state.conflict, null);
});

test('a lost remote create checkpoint adopts an exact idempotent-conflict retry', async t => {
  const { localLibrary, stateStore: durableStateStore } = await stores(t);
  const id = 'sermon-create-lost-checkpoint';
  const local = await localLibrary.saveDocument(
    sermonDocument(id, 'New Community sermon'),
    { expectedRevision: null }
  );
  let remote = null;
  let createCalls = 0;
  let firstIdempotencyKey = null;
  const client = clientFor(null, {
    create: options => {
      createCalls += 1;
      if (createCalls === 1) {
        firstIdempotencyKey = options.idempotencyKey;
        remote = envelopeFor(local.sermon, { syncVersion: 1 });
        return remote;
      }
      assert.equal(options.idempotencyKey, firstIdempotencyKey);
      const error = new Error('already committed');
      error.code = 'REVISION_CONFLICT';
      throw error;
    }
  });
  client.getSermon = async options => {
    client.calls.get.push(options);
    return remote;
  };
  let failCheckpoint = true;
  const flakyStateStore = {
    getConnectionState: (...args) => durableStateStore.getConnectionState(...args),
    saveConnectionState: (...args) => {
      if (failCheckpoint) {
        failCheckpoint = false;
        const error = new Error('simulated checkpoint failure');
        error.code = 'STORE_WRITE_FAILED';
        throw error;
      }
      return durableStateStore.saveConnectionState(...args);
    }
  };
  const engine = syncEngine({ client, localLibrary, stateStore: flakyStateStore });

  await assert.rejects(
    engine.pushSermon(id, { expectedLocalRevision: local.revision }),
    error => error.code === 'STORE_WRITE_FAILED'
  );
  const retried = await engine.pushSermon(id, {
    expectedLocalRevision: local.revision
  });
  assert.equal(retried.operation, 'adopted');
  assert.equal(retried.status, 'synced');
  assert.equal(createCalls, 2);
  assert.equal(client.calls.get.length, 1);
  const state = await durableStateStore.getSermonState(CONNECTION_ID, id);
  assert.equal(state.syncVersion, 1);
  assert.equal(state.localRevision, local.revision);
  assert.equal(state.remoteRevision, local.revision);
  assert.equal(state.conflict, null);
});

test('a lost remote update checkpoint adopts an exact fetch-after-412 retry', async t => {
  const { localLibrary, stateStore: durableStateStore } = await stores(t);
  const id = 'sermon-push-lost-checkpoint';
  const baseline = await localLibrary.saveDocument(
    sermonDocument(id, 'Baseline'),
    { expectedRevision: null }
  );
  await durableStateStore.saveConnectionState(CONNECTION_ID, {
    songs: {},
    sermons: {
      [id]: {
        syncId: id,
        localSermonId: id,
        syncVersion: 1,
        localRevision: baseline.revision,
        remoteRevision: baseline.revision
      }
    }
  });
  const local = await localLibrary.saveDocument(sermonDocument(id, 'Local update'), {
    expectedSermonId: id,
    expectedRevision: baseline.revision
  });
  let remote = envelopeFor(baseline.sermon, { syncVersion: 1 });
  let updateCalls = 0;
  const client = clientFor(remote, {
    update: options => {
      updateCalls += 1;
      if (updateCalls === 1) {
        assert.equal(options.expectedSyncVersion, 1);
        remote = envelopeFor(local.sermon, { syncVersion: 2 });
        return remote;
      }
      const error = new Error('stale expected version');
      error.code = 'REVISION_CONFLICT';
      throw error;
    }
  });
  client.getSermon = async options => {
    client.calls.get.push(options);
    return remote;
  };
  let failCheckpoint = true;
  const flakyStateStore = {
    getConnectionState: (...args) => durableStateStore.getConnectionState(...args),
    saveConnectionState: (...args) => {
      if (failCheckpoint) {
        failCheckpoint = false;
        const error = new Error('simulated checkpoint failure');
        error.code = 'STORE_WRITE_FAILED';
        throw error;
      }
      return durableStateStore.saveConnectionState(...args);
    }
  };
  const engine = syncEngine({ client, localLibrary, stateStore: flakyStateStore });

  await assert.rejects(
    engine.pushSermon(id, {
      expectedSyncVersion: 1,
      expectedLocalRevision: local.revision
    }),
    error => error.code === 'STORE_WRITE_FAILED'
  );
  const retried = await engine.pushSermon(id, {
    expectedSyncVersion: 1,
    expectedLocalRevision: local.revision
  });
  assert.equal(retried.operation, 'adopted');
  assert.equal(retried.status, 'synced');
  assert.equal(updateCalls, 2);
  assert.equal(client.calls.get.length, 1);
  const state = await durableStateStore.getSermonState(CONNECTION_ID, id);
  assert.equal(state.syncVersion, 2);
  assert.equal(state.localRevision, local.revision);
  assert.equal(state.remoteRevision, local.revision);
  assert.equal(state.conflict, null);
});

test('constructor and explicit push reject clients or identity remapping', async t => {
  const { localLibrary, stateStore } = await stores(t);
  assert.throws(
    () => new CommunitySermonSync({
      client: {},
      localLibrary,
      stateStore,
      connectionId: CONNECTION_ID,
      accessTokenProvider: async () => ACCESS_TOKEN
    }),
    TypeError
  );

  await localLibrary.saveDocument(sermonDocument('sermon-one', 'One'), {
    expectedRevision: null
  });
  const engine = syncEngine({
    client: clientFor(null),
    localLibrary,
    stateStore
  });
  await assert.rejects(
    engine.pushSermon('sermon-one', { syncId: 'sermon-two' }),
    error => error instanceof CommunitySermonSyncError
      && error.code === 'SERMON_IDENTITY_CONFLICT'
  );
});
