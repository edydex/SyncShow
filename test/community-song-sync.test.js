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
  CommunitySongFamilyImportCoordinator,
  transactionIdFor
} = require('../src/services/community/CommunitySongFamilyImportCoordinator');
const {
  CommunitySyncStateStore
} = require('../src/services/community/CommunitySyncStateStore');
const {
  RECEIPT_KEYS,
  buildSongMemberSharingRequest
} = require('../src/services/community/CommunitySongMemberSharing');
const {
  songFamilyRevision,
  songSharingReviewRevision
} = require('../src/services/community/CommunitySongSharingReview');
const {
  LocalSongLibrary,
  idStorageKey
} = require('../src/services/project/LocalSongLibrary');
const {
  FAMILY_JOURNAL_FILE,
  SLOT_BYTES,
  SLOT_HEADER_BYTES,
  DurableFamilyJournal
} = require('../src/services/project/DurableFamilyJournal');
const {
  parseSongDocument
} = require('../src/services/project/SongDocument');

const ACCESS_TOKEN = 'community-access-token-0000000001';
const CONNECTION_ID = 'connection-00000001';
const NOW = '2026-07-25T12:00:00.000Z';
const importCoordinators = new WeakMap();

async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'syncshow-community-sync-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const realRoot = await fs.realpath(root);
  const recoveryAuthority = Symbol('test-community-family-import');
  const library = new LocalSongLibrary({
    rootPath: path.join(realRoot, 'songs'),
    familyRecoveryAuthority: recoveryAuthority
  });
  const familyImportCoordinator =
    new CommunitySongFamilyImportCoordinator({
      rootPath: path.join(realRoot, 'songs'),
      songLibrary: library,
      recoveryAuthority,
      clock: () => new Date(NOW)
    });
  importCoordinators.set(library, familyImportCoordinator);
  return {
    library,
    familyImportCoordinator,
    recoveryAuthority,
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

async function localFamilyRevision(library, ids) {
  const documents = await Promise.all(ids.map(id => library.read(id)));
  return songFamilyRevision({ documents });
}

async function confirmMemberSharingReview(
  stateStore,
  library,
  familyId,
  ids,
  requested = {}
) {
  const familyRevision = await localFamilyRevision(library, ids);
  const current = await stateStore.getSongSharingReview(
    CONNECTION_ID,
    familyId
  );
  const review = await stateStore.confirmSongSharingReview(
    CONNECTION_ID,
    familyId,
    {
      basis: 'public-domain',
      familyRevision,
      expectedReviewRevision: songSharingReviewRevision(current),
      ...requested
    }
  );
  return { familyRevision, review };
}

async function applyMemberSharing(sync, stateStore, library, familyId, ids, {
  visibility = 'public',
  publishAt = null,
  expectedSyncVersion = null,
  basis = 'church-license',
  evidence = 'Verified church license covers signed-in member access.',
  validUntil = null
} = {}) {
  const familyRevision = await localFamilyRevision(library, ids);
  const current = await stateStore.getSongSharingReview(
    CONNECTION_ID,
    familyId
  );
  return sync.syncSong(familyId, {
    visibilityForSong: () => ({
      visibility,
      publishAt,
      expectedSyncVersion,
      expectedFamilyRevision: familyRevision,
      sharingReview: {
        basis,
        evidence,
        validUntil,
        expectedReviewRevision: songSharingReviewRevision(current)
      }
    })
  });
}

function remoteSong({
  syncId = 'amazing-grace',
  syncVersion = 1,
  syncDocuments = [],
  title = 'Amazing Grace',
  alternateTitles = [],
  visibility = 'private',
  publishAt = null,
  archived = false,
  rightsStatus,
  rightsNotes
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
    ...(rightsStatus === undefined ? {} : { rightsStatus }),
    ...(rightsNotes === undefined ? {} : { rightsNotes }),
    updatedAt: NOW
  };
}

function clientStub(overrides = {}) {
  const remoteById = new Map();
  const base = {
    listSongChanges: async () => ({ items: [], nextCursor: 'cursor-1', hasMore: false }),
    createSong: async input => remoteSong({
      syncId: input.syncId,
      syncDocuments: input.syncDocuments,
      visibility: input.visibility,
      publishAt: input.publishAt,
      rightsStatus: input.rightsStatus,
      rightsNotes: input.rightsNotes
    }),
    updateSong: async input => remoteSong({
      syncId: input.syncId,
      syncVersion: input.expectedSyncVersion + 1,
      syncDocuments: input.syncDocuments || [],
      visibility: input.visibility || 'private',
      publishAt: input.publishAt || null,
      rightsStatus: input.rightsStatus,
      rightsNotes: input.rightsNotes
    }),
    getSong: async ({ syncId }) => remoteSong({ syncId }),
    ...overrides
  };
  const wrapped = {};
  for (const method of ['listSongChanges', 'createSong', 'updateSong', 'getSong']) {
    wrapped[method] = async input => {
      const result = await base[method](input);
      if (method === 'listSongChanges') {
        for (const item of result.items || []) {
          remoteById.set(item.syncId, item);
        }
      } else if (result?.syncId) {
        remoteById.set(result.syncId, result);
      }
      return result;
    };
  }
  wrapped.shareSongWithMembers = overrides.shareSongWithMembers
    || (async input => {
      const current = remoteById.get(input.syncId)
        || await wrapped.getSong({ syncId: input.syncId });
      const shared = remoteSong({
        syncId: input.syncId,
        syncVersion: input.expectedSyncVersion + 1,
        syncDocuments: current.syncDocuments || [],
        title: current.title,
        alternateTitles: current.alternateTitles,
        visibility: input.visibility,
        publishAt: input.publishAt,
        rightsStatus: current.rightsStatus,
        rightsNotes: current.rightsNotes
      });
      const request = buildSongMemberSharingRequest({
        syncId: input.syncId,
        expectedSyncVersion: input.expectedSyncVersion,
        familyRevision: input.familyRevision,
        review: input.review,
        reviewRevision: input.reviewRevision,
        visibility: input.visibility,
        publishAt: input.publishAt
      });
      const receipt = {
        schemaVersion: 1,
        receiptId: crypto.createHash('sha256')
          .update(request.requestRevision)
          .digest('base64url'),
        receiptVersion: 1,
        songSyncId: input.syncId,
        previousSongSyncVersion: input.expectedSyncVersion,
        songSyncVersion: shared.syncVersion,
        familyRevision: input.familyRevision,
        reviewRevision: input.reviewRevision,
        visibility: input.visibility,
        publishAt: input.publishAt,
        timeZone: 'UTC',
        validThrough: input.review.validUntil
          ? `${input.review.validUntil}T23:59:59.999Z`
          : null,
        reviewedAt: input.review.reviewedAt,
        confirmedAt: NOW,
        requestRevision: request.requestRevision,
        receiptRevision: null
      };
      receipt.receiptRevision = crypto.createHash('sha256')
        .update(JSON.stringify(
          RECEIPT_KEYS
            .filter(key => key !== 'receiptRevision')
            .map(key => receipt[key])
        ))
        .digest('hex');
      shared.effectiveVisibility = input.visibility === 'public'
        ? 'public'
        : 'private';
      shared.memberSharing = receipt;
      remoteById.set(input.syncId, shared);
      return {
        receipt,
        song: shared
      };
    });
  return wrapped;
}

function synchronizer({
  client,
  library,
  stateStore,
  familyImportCoordinator = importCoordinators.get(library),
  now = () => new Date(NOW)
}) {
  return new CommunitySongSync({
    client,
    localLibrary: library,
    familyImportCoordinator,
    stateStore,
    connectionId: CONNECTION_ID,
    accessTokenProvider: async () => ACCESS_TOKEN,
    now
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

test('an explicitly write-enabled family upload orders original before translations and defaults to private', async t => {
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
  assert.equal(
    await stateStore.getSongSharingReview(CONNECTION_ID, 'root-song'),
    null,
    'private admin-only staging does not mint or require a member-sharing review'
  );
  assert.equal(result.reviewRequired, 0);
});

test('an explicit private submission sends exact family rights evidence and checkpoints the review', async t => {
  const { library, stateStore } = await workspace(t);
  const local = await library.saveSource(songSource({
    id: 'reviewed-private-song',
    title: 'Reviewed Private Song'
  }));
  const creates = [];
  const client = clientStub({
    createSong: async input => {
      creates.push(input);
      return remoteSong({
        syncId: input.syncId,
        syncDocuments: input.syncDocuments,
        visibility: input.visibility,
        publishAt: input.publishAt,
        rightsStatus: input.rightsStatus,
        rightsNotes: input.rightsNotes
      });
    }
  });

  const result = await applyMemberSharing(
    synchronizer({ client, library, stateStore }),
    stateStore,
    library,
    local.song.id,
    [local.song.id],
    {
      visibility: 'private',
      basis: 'church-license',
      evidence: 'License section 3 reviewed for the exact church catalog use.'
    }
  );

  assert.equal(result.status, 'synced');
  assert.equal(result.pushed, 1);
  assert.equal(creates.length, 1);
  assert.equal(creates[0].visibility, 'private');
  assert.equal(creates[0].rightsStatus, 'licensed');
  assert.match(creates[0].rightsNotes, /Community admins only/);
  assert.match(creates[0].rightsNotes, /License section 3 reviewed/);
  assert.match(creates[0].rightsNotes, /Exact family revision: [a-f0-9]{64}/);
  const storedReview = await stateStore.getSongSharingReview(
    CONNECTION_ID,
    local.song.id
  );
  assert.equal(storedReview.basis, 'church-license');
  assert.equal(storedReview.familyRevision, await localFamilyRevision(
    library,
    [local.song.id]
  ));
  assert.equal(
    (await stateStore.getSongState(CONNECTION_ID, local.song.id)).visibility,
    'private'
  );
});

test('new-family creation rejects remapped identity and incomplete document echoes', async t => {
  const { library, stateStore } = await workspace(t);
  const local = await library.saveSource(songSource({
    id: 'guarded-create',
    title: 'Guarded Create'
  }));
  let responseKind = 'identity';
  const client = clientStub({
    createSong: async input => remoteSong({
      syncId: responseKind === 'identity' ? 'different-record' : input.syncId,
      syncVersion: 1,
      syncDocuments: responseKind === 'documents' ? [] : input.syncDocuments,
      visibility: input.visibility,
      publishAt: input.publishAt
    })
  });
  const sync = synchronizer({ client, library, stateStore });

  await assert.rejects(
    sync.syncSong(local.song.id),
    error => error.code === 'REMOTE_ID_MISMATCH'
  );
  responseKind = 'documents';
  await assert.rejects(
    sync.syncSong(local.song.id),
    error => error.code === 'REMOTE_CONTENT_MISMATCH'
  );
  assert.deepEqual(
    Object.keys((await stateStore.getConnectionState(CONNECTION_ID)).songs),
    [],
    'a malformed create response must not be adopted under either identity'
  );
});

test('updates reject version reuse, archived records, visibility drift, and non-echoed exact content', async t => {
  const { library, stateStore } = await workspace(t);
  const baseline = await library.saveSource(songSource({
    id: 'guarded-update',
    title: 'Guarded Update',
    line: 'Baseline'
  }));
  let responseKind = 'valid';
  const client = clientStub({
    updateSong: async input => {
      if (responseKind === 'version') {
        return remoteSong({
          syncId: input.syncId,
          syncVersion: input.expectedSyncVersion,
          syncDocuments: input.syncDocuments,
          visibility: 'private'
        });
      }
      if (responseKind === 'visibility') {
        return remoteSong({
          syncId: input.syncId,
          syncVersion: input.expectedSyncVersion + 1,
          syncDocuments: input.syncDocuments,
          visibility: 'public'
        });
      }
      if (responseKind === 'documents') {
        return remoteSong({
          syncId: input.syncId,
          syncVersion: input.expectedSyncVersion + 1,
          syncDocuments: [{
            id: baseline.song.id,
            source: baseline.source,
            revision: baseline.revision
          }],
          visibility: 'private'
        });
      }
      if (responseKind === 'archived') {
        return remoteSong({
          syncId: input.syncId,
          syncVersion: input.expectedSyncVersion + 1,
          syncDocuments: input.syncDocuments,
          visibility: 'private',
          archived: true
        });
      }
      return remoteSong({
        syncId: input.syncId,
        syncVersion: input.expectedSyncVersion + 1,
        syncDocuments: input.syncDocuments,
        visibility: input.visibility || 'private',
        publishAt: input.publishAt || null
      });
    }
  });
  const sync = synchronizer({ client, library, stateStore });
  await sync.sync();
  await library.saveSource(songSource({
    id: baseline.song.id,
    title: baseline.song.title,
    line: 'Changed locally'
  }), { expectedRevision: baseline.revision });

  responseKind = 'version';
  await assert.rejects(
    sync.syncSong(baseline.song.id),
    error => error.code === 'REMOTE_VERSION_REUSE'
  );
  responseKind = 'visibility';
  await assert.rejects(
    sync.syncSong(baseline.song.id),
    error => error.code === 'COMMUNITY_VISIBILITY_NOT_APPLIED'
  );
  responseKind = 'documents';
  await assert.rejects(
    sync.syncSong(baseline.song.id),
    error => error.code === 'REMOTE_CONTENT_MISMATCH'
  );
  responseKind = 'archived';
  await assert.rejects(
    sync.syncSong(baseline.song.id),
    error => error.code === 'REMOTE_ARCHIVED'
  );
  const retained = await stateStore.getSongState(CONNECTION_ID, baseline.song.id);
  assert.equal(retained.syncVersion, 1);
  assert.equal(
    retained.documents[baseline.song.id].localRevision,
    baseline.revision,
    'none of the malformed responses may advance the saved synchronization baseline'
  );
});

test('remote pages reject version regression and same-version canonical or document substitution', async t => {
  const { library, stateStore } = await workspace(t);
  const originalSource = songSource({
    id: 'continuity-song',
    title: 'Continuity Song',
    line: 'Original remote content'
  });
  const changedSource = songSource({
    id: 'continuity-song',
    title: 'Continuity Song',
    line: 'Substituted remote content'
  });
  const originalDocument = {
    id: 'continuity-song',
    source: originalSource,
    revision: crypto.createHash('sha256').update(originalSource).digest('hex')
  };
  const changedDocument = {
    id: 'continuity-song',
    source: changedSource,
    revision: crypto.createHash('sha256').update(changedSource).digest('hex')
  };
  const baselineRemote = {
    ...remoteSong({
      syncId: 'continuity-song',
      syncVersion: 2,
      syncDocuments: [originalDocument],
      title: 'Continuity Song'
    }),
    revision: 'song:continuity-song:baseline'
  };
  let responseKind = 'baseline';
  let cursor = 0;
  const client = clientStub({
    listSongChanges: async () => {
      let remote = baselineRemote;
      if (responseKind === 'canonical') {
        remote = {
          ...remoteSong({
            syncId: 'continuity-song',
            syncVersion: 2,
            syncDocuments: [changedDocument],
            title: 'Continuity Song'
          }),
          revision: 'song:continuity-song:substituted'
        };
      } else if (responseKind === 'documents') {
        remote = {
          ...remoteSong({
            syncId: 'continuity-song',
            syncVersion: 2,
            syncDocuments: [changedDocument],
            title: 'Continuity Song'
          }),
          revision: baselineRemote.revision
        };
      } else if (responseKind === 'regression') {
        remote = remoteSong({
          syncId: 'continuity-song',
          syncVersion: 1,
          syncDocuments: [changedDocument],
          title: 'Continuity Song'
        });
      }
      return {
        items: [remote],
        nextCursor: `continuity-cursor-${cursor += 1}`,
        hasMore: false
      };
    }
  });
  const sync = synchronizer({ client, library, stateStore });

  await sync.sync();
  const baselineLocal = await library.read('continuity-song');
  const baselineState = await stateStore.getSongState(
    CONNECTION_ID,
    'continuity-song'
  );

  responseKind = 'canonical';
  await assert.rejects(
    sync.sync(),
    error => error.code === 'REMOTE_VERSION_REUSE'
  );
  responseKind = 'documents';
  await assert.rejects(
    sync.sync(),
    error => error.code === 'REMOTE_VERSION_REUSE'
  );
  responseKind = 'regression';
  await assert.rejects(
    sync.sync(),
    error => error.code === 'REMOTE_VERSION_REGRESSION'
  );

  assert.equal((await library.read('continuity-song')).revision, baselineLocal.revision);
  const retainedState = await stateStore.getSongState(
    CONNECTION_ID,
    'continuity-song'
  );
  assert.equal(retainedState.syncVersion, baselineState.syncVersion);
  assert.equal(retainedState.remoteRevision, baselineState.remoteRevision);
  assert.equal(
    retainedState.documents['continuity-song'].remoteRevision,
    originalDocument.revision
  );
});

test('an unchanged remote conflict remains stable while same-version conflict substitution is rejected', async t => {
  const { library, stateStore } = await workspace(t);
  const baseline = await library.saveSource(songSource({
    id: 'conflict-continuity',
    title: 'Conflict Continuity',
    line: 'Shared baseline'
  }));
  let remote = remoteSong({
    syncId: baseline.song.id,
    syncVersion: 1,
    syncDocuments: [{
      id: baseline.song.id,
      source: baseline.source,
      revision: baseline.revision
    }],
    title: baseline.song.title
  });
  let cursor = 0;
  const client = clientStub({
    listSongChanges: async () => ({
      items: [remote],
      nextCursor: `conflict-continuity-${cursor += 1}`,
      hasMore: false
    })
  });
  const sync = synchronizer({ client, library, stateStore });
  await sync.sync();

  const localChanged = await library.saveSource(songSource({
    id: baseline.song.id,
    title: baseline.song.title,
    line: 'Local conflict copy'
  }), {
    expectedSongId: baseline.song.id,
    expectedRevision: baseline.revision
  });
  const remoteChangedSource = songSource({
    id: baseline.song.id,
    title: baseline.song.title,
    line: 'Remote conflict copy'
  });
  const remoteChangedDocument = {
    id: baseline.song.id,
    source: remoteChangedSource,
    revision: crypto.createHash('sha256').update(remoteChangedSource).digest('hex')
  };
  remote = remoteSong({
    syncId: baseline.song.id,
    syncVersion: 2,
    syncDocuments: [remoteChangedDocument],
    title: baseline.song.title
  });

  const detected = await sync.sync();
  assert.equal(detected.conflicts, 1);
  const conflict = await stateStore.getSongState(CONNECTION_ID, baseline.song.id);
  assert.equal(conflict.conflict.code, 'BOTH_CHANGED');
  assert.equal(conflict.conflict.remoteSyncVersion, 2);

  const unchanged = await sync.sync();
  assert.equal(unchanged.conflicts, 1);
  assert.equal(
    (await stateStore.getSongState(CONNECTION_ID, baseline.song.id))
      .conflict.remoteDocuments[0].revision,
    remoteChangedDocument.revision
  );

  const advancedSource = songSource({
    id: baseline.song.id,
    title: baseline.song.title,
    line: 'Advanced remote conflict copy'
  });
  const advancedDocument = {
    id: baseline.song.id,
    source: advancedSource,
    revision: crypto.createHash('sha256').update(advancedSource).digest('hex')
  };
  remote = remoteSong({
    syncId: baseline.song.id,
    syncVersion: 3,
    syncDocuments: [advancedDocument],
    title: baseline.song.title
  });
  const advanced = await sync.sync();
  assert.equal(advanced.conflicts, 1);
  const advancedConflict = await stateStore.getSongState(
    CONNECTION_ID,
    baseline.song.id
  );
  assert.equal(advancedConflict.conflict.remoteSyncVersion, 3);
  assert.equal(
    advancedConflict.conflict.remoteDocuments[0].revision,
    advancedDocument.revision
  );
  assert.equal((await sync.sync()).conflicts, 1);

  const substitutedSource = songSource({
    id: baseline.song.id,
    title: baseline.song.title,
    line: 'Substituted at the reused version'
  });
  remote = remoteSong({
    syncId: baseline.song.id,
    syncVersion: 3,
    syncDocuments: [{
      id: baseline.song.id,
      source: substitutedSource,
      revision: crypto.createHash('sha256').update(substitutedSource).digest('hex')
    }],
    title: baseline.song.title
  });
  await assert.rejects(
    sync.sync(),
    error => error.code === 'REMOTE_VERSION_REUSE'
  );
  assert.equal((await library.read(baseline.song.id)).revision, localChanged.revision);
  assert.equal(
    (await stateStore.getSongState(CONNECTION_ID, baseline.song.id))
      .conflict.remoteDocuments[0].revision,
    advancedDocument.revision
  );
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

test('a remote record containing two independent song families is rejected before import', async t => {
  const { library, stateStore } = await workspace(t);
  const firstSource = songSource({
    id: 'first-independent-root',
    title: 'First Independent Root',
    line: 'First root'
  });
  const secondSource = songSource({
    id: 'second-independent-root',
    title: 'Second Independent Root',
    line: 'Second root'
  });
  const document = (id, source) => ({
    id,
    source,
    revision: crypto.createHash('sha256').update(source).digest('hex')
  });
  const client = clientStub({
    listSongChanges: async () => ({
      items: [remoteSong({
        syncId: 'malformed-multi-family',
        syncVersion: 1,
        syncDocuments: [
          document('first-independent-root', firstSource),
          document('second-independent-root', secondSource)
        ],
        title: 'Malformed Multi Family'
      })],
      nextCursor: 'malformed-multi-family-cursor',
      hasMore: false
    })
  });

  const result = await synchronizer({ client, library, stateStore }).sync();

  assert.equal(result.conflicts, 1);
  assert.equal(result.warnings[0].code, 'INVALID_REMOTE_DOCUMENTS');
  assert.deepEqual((await library.list()).items, []);
  const state = await stateStore.getSongState(
    CONNECTION_ID,
    'malformed-multi-family'
  );
  assert.equal(state.conflict.code, 'INVALID_REMOTE_DOCUMENTS');
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

test('targeted sync enriches a uniquely matched remote with a different sync ID instead of creating a duplicate', async t => {
  const { library, stateStore } = await workspace(t);
  const local = await library.saveSource(songSource({
    id: 'targeted-local-id',
    title: 'Targeted Legacy Match'
  }));
  const legacy = remoteSong({
    syncId: 'legacy-community-id',
    syncVersion: 9,
    syncDocuments: [],
    title: local.song.title
  });
  const creates = [];
  const updates = [];
  const client = clientStub({
    listSongChanges: async ({ cursor }) => {
      assert.equal(cursor, null, 'targeted matching needs a complete remote snapshot');
      return {
        items: [legacy],
        nextCursor: 'targeted-legacy-cursor',
        hasMore: false
      };
    },
    createSong: async input => {
      creates.push(input);
      return remoteSong({
        syncId: input.syncId,
        syncDocuments: input.syncDocuments
      });
    },
    updateSong: async input => {
      updates.push(input);
      return remoteSong({
        syncId: legacy.syncId,
        syncVersion: input.expectedSyncVersion + 1,
        syncDocuments: input.syncDocuments,
        title: legacy.title
      });
    }
  });

  const result = await synchronizer({
    client,
    library,
    stateStore
  }).syncSong(local.song.id);

  assert.equal(result.pushed, 1);
  assert.equal(creates.length, 0, 'the differently keyed remote must not be duplicated');
  assert.equal(updates.length, 1);
  assert.equal(updates[0].syncId, legacy.syncId);
  assert.equal(updates[0].syncDocuments[0].id, local.song.id);
  assert.equal(
    (await stateStore.getSongState(CONNECTION_ID, legacy.syncId)).localFamilyId,
    local.song.id
  );
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

test('a second remote record for an already-paired local family is quarantined', async t => {
  const { library, stateStore } = await workspace(t);
  const local = await library.saveSource(songSource({
    id: 'paired-family',
    title: 'Paired Family',
    line: 'Paired content'
  }));
  await stateStore.saveConnectionState(CONNECTION_ID, {
    songs: {
      'legacy-remote-record': {
        syncId: 'legacy-remote-record',
        localFamilyId: local.song.id,
        remoteTitle: local.song.title,
        alternateTitles: [],
        syncVersion: 1,
        remoteRevision: 'song:legacy-remote-record:1',
        documents: {
          [local.song.id]: {
            localRevision: local.revision,
            remoteRevision: local.revision
          }
        },
        visibility: 'private',
        publishAt: null,
        pendingVisibility: null,
        archived: false,
        metadataOnly: false,
        lastSyncedAt: NOW,
        conflict: null
      },
      'duplicate-remote-record': {
        syncId: 'duplicate-remote-record',
        localFamilyId: local.song.id,
        remoteTitle: local.song.title,
        alternateTitles: [],
        syncVersion: 1,
        remoteRevision: 'song:duplicate-remote-record:1',
        documents: {
          [local.song.id]: {
            localRevision: local.revision,
            remoteRevision: local.revision
          }
        },
        visibility: 'public',
        publishAt: null,
        pendingVisibility: null,
        archived: false,
        metadataOnly: false,
        lastSyncedAt: NOW,
        conflict: {
          code: 'AMBIGUOUS_REMOTE_MATCH',
          detectedAt: NOW,
          localRevision: local.revision,
          remoteRevision: 'song:duplicate-remote-record:1',
          remoteSyncVersion: 1,
          remoteDocuments: [{
            id: local.song.id,
            source: local.source,
            revision: local.revision
          }]
        }
      }
    }
  });
  const duplicate = remoteSong({
    syncId: 'duplicate-remote-record',
    syncVersion: 1,
    syncDocuments: [{
      id: local.song.id,
      source: local.source,
      revision: local.revision
    }],
    title: local.song.title,
    visibility: 'public'
  });
  let updates = 0;
  const client = clientStub({
    listSongChanges: async () => ({
      items: [duplicate],
      nextCursor: 'duplicate-remote-record-cursor',
      hasMore: false
    }),
    updateSong: async () => {
      updates += 1;
      throw new Error('a quarantined duplicate must not be updated');
    }
  });

  const result = await synchronizer({ client, library, stateStore }).sync();

  assert.equal(result.conflicts, 1);
  assert.equal(result.warnings[0].code, 'AMBIGUOUS_REMOTE_MATCH');
  assert.equal(updates, 0);
  const state = await stateStore.getConnectionState(CONNECTION_ID);
  assert.equal(state.songs['legacy-remote-record'].localFamilyId, local.song.id);
  assert.equal(state.songs['duplicate-remote-record'].localFamilyId, null);
  assert.equal(
    state.songs['duplicate-remote-record'].conflict.code,
    'AMBIGUOUS_REMOTE_MATCH'
  );
  assert.equal(state.songs['duplicate-remote-record'].visibility, 'public');
  assert.equal((await library.read(local.song.id)).revision, local.revision);
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

test('a content-bearing remote that becomes metadata-only is preserved as a conflict', async t => {
  const { library, stateStore } = await workspace(t);
  const local = await library.saveSource(songSource({
    id: 'metadata-loss-guard',
    title: 'Metadata Loss Guard',
    line: 'Preserved content'
  }));
  let remote = remoteSong({
    syncId: local.song.id,
    syncVersion: 1,
    syncDocuments: [{
      id: local.song.id,
      source: local.source,
      revision: local.revision
    }],
    title: local.song.title
  });
  let cursor = 0;
  let writes = 0;
  const client = clientStub({
    listSongChanges: async () => ({
      items: [remote],
      nextCursor: `metadata-loss-${cursor += 1}`,
      hasMore: false
    }),
    updateSong: async () => {
      writes += 1;
      throw new Error('missing remote documents must not be silently rewritten');
    }
  });
  const sync = synchronizer({ client, library, stateStore });
  await sync.sync();

  remote = remoteSong({
    syncId: local.song.id,
    syncVersion: 2,
    syncDocuments: [],
    title: local.song.title
  });
  const result = await sync.sync();

  assert.equal(result.conflicts, 1);
  assert.equal(result.warnings[0].code, 'REMOTE_DOCUMENTS_MISSING');
  assert.equal(writes, 0);
  assert.equal((await library.read(local.song.id)).revision, local.revision);
  const state = await stateStore.getSongState(CONNECTION_ID, local.song.id);
  assert.equal(state.conflict.code, 'REMOTE_DOCUMENTS_MISSING');
  assert.equal(state.conflict.remoteSyncVersion, 2);
  assert.deepEqual(state.conflict.remoteDocuments, []);
  assert.equal(
    state.documents[local.song.id].remoteRevision,
    local.revision
  );
});

test('read-only sync pulls Community changes while issuing zero create or update requests', async t => {
  const { library, stateStore } = await workspace(t);
  const tracked = await library.saveSource(songSource({
    id: 'read-only-tracked',
    title: 'Read Only Tracked',
    line: 'Tracked baseline'
  }));
  await library.saveSource(songSource({
    id: 'read-only-new-local',
    title: 'Read Only New Local',
    line: 'Must remain local'
  }));
  await stateStore.saveConnectionState(CONNECTION_ID, {
    cursor: 'read-only-baseline',
    lastSyncAt: NOW,
    songs: {
      [tracked.song.id]: {
        syncId: tracked.song.id,
        localFamilyId: tracked.song.id,
        remoteTitle: tracked.song.title,
        alternateTitles: [],
        syncVersion: 3,
        remoteRevision: `song:${tracked.song.id}:3`,
        documents: {
          [tracked.song.id]: {
            localRevision: tracked.revision,
            remoteRevision: tracked.revision
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
  const changed = await library.saveSource(songSource({
    id: tracked.song.id,
    title: tracked.song.title,
    line: 'Unsynced local edit'
  }), {
    expectedSongId: tracked.song.id,
    expectedRevision: tracked.revision
  });
  const remoteOnlySource = songSource({
    id: 'read-only-remote',
    title: 'Read Only Remote',
    line: 'Pulled from Community'
  });
  const remoteOnlyDocument = {
    id: 'read-only-remote',
    source: remoteOnlySource,
    revision: crypto.createHash('sha256').update(remoteOnlySource).digest('hex')
  };
  let creates = 0;
  let updates = 0;
  const client = clientStub({
    listSongChanges: async () => ({
      items: [
        remoteSong({
          syncId: tracked.song.id,
          syncVersion: 3,
          syncDocuments: [{
            id: tracked.song.id,
            source: tracked.source,
            revision: tracked.revision
          }],
          title: tracked.song.title
        }),
        remoteSong({
          syncId: 'read-only-remote',
          syncDocuments: [remoteOnlyDocument],
          title: 'Read Only Remote'
        })
      ],
      nextCursor: 'read-only-final',
      hasMore: false
    }),
    createSong: async input => {
      creates += 1;
      return remoteSong({
        syncId: input.syncId,
        syncDocuments: input.syncDocuments
      });
    },
    updateSong: async input => {
      updates += 1;
      return remoteSong({
        syncId: input.syncId,
        syncVersion: input.expectedSyncVersion + 1,
        syncDocuments: input.syncDocuments || [],
        visibility: input.visibility || 'private',
        publishAt: input.publishAt || null
      });
    }
  });

  const result = await synchronizer({
    client,
    library,
    stateStore
  }).sync({ allowWrites: false });

  assert.equal(result.pushed, 0);
  assert.equal(creates, 0);
  assert.equal(updates, 0);
  assert.match((await library.read('read-only-remote')).source, /Pulled from Community/);
  assert.equal(
    (await library.read(tracked.song.id)).revision,
    changed.revision,
    'the unsynced local edit remains authoritative'
  );
});

test('exact song pull uses one GET, preserves the feed cursor, and never calls list or write APIs', async t => {
  const { library, stateStore } = await workspace(t);
  const priorLastSyncAt = '2026-07-24T11:00:00.000Z';
  const source = songSource({
    id: 'planned-song',
    title: 'Planned Song',
    line: 'Prepared from the exact plan'
  });
  const document = {
    id: 'planned-song',
    source,
    revision: crypto.createHash('sha256').update(source).digest('hex')
  };
  const remote = remoteSong({
    syncId: 'planned-song',
    syncVersion: 7,
    syncDocuments: [document],
    title: 'Planned Song'
  });
  await stateStore.saveConnectionState(CONNECTION_ID, {
    cursor: 'keep-this-song-cursor',
    lastSyncAt: priorLastSyncAt,
    songs: {}
  });
  const calls = { get: 0, list: 0, create: 0, update: 0 };
  const client = clientStub({
    getSong: async ({ syncId }) => {
      calls.get += 1;
      assert.equal(syncId, 'planned-song');
      return remote;
    },
    listSongChanges: async () => {
      calls.list += 1;
      throw new Error('exact pull must not read the song feed');
    },
    createSong: async () => {
      calls.create += 1;
      throw new Error('exact pull must not create Community songs');
    },
    updateSong: async () => {
      calls.update += 1;
      throw new Error('exact pull must not update Community songs');
    }
  });

  const result = await synchronizer({
    client,
    library,
    stateStore
  }).pullSong('planned-song', {
    expectedSyncVersion: 7,
    expectedRevision: 'song:planned-song:7'
  });

  assert.equal(result.status, 'synced');
  assert.equal(result.pulled, 1);
  assert.deepEqual(calls, { get: 1, list: 0, create: 0, update: 0 });
  assert.match(
    (await library.read('planned-song')).source,
    /Prepared from the exact plan/
  );
  const state = await stateStore.getConnectionState(CONNECTION_ID);
  assert.equal(state.cursor, 'keep-this-song-cursor');
  assert.equal(
    state.lastSyncAt,
    priorLastSyncAt,
    'an exact point pull must not advance the global song-sync lane timestamp'
  );
});

test('exact song pull does not title-match a different local family', async t => {
  const { library, stateStore } = await workspace(t);
  const local = await library.saveSource(songSource({
    id: 'local-shared-title',
    title: 'Shared Worship Title',
    line: 'Keep this unrelated local family'
  }));
  const remoteSource = songSource({
    id: 'remote-shared-title',
    title: 'Shared Worship Title',
    line: 'Import only under the exact remote identity'
  });
  const remote = remoteSong({
    syncId: 'remote-shared-title',
    syncVersion: 4,
    syncDocuments: [{
      id: 'remote-shared-title',
      source: remoteSource,
      revision: crypto.createHash('sha256').update(remoteSource).digest('hex')
    }],
    title: 'Shared Worship Title'
  });
  await stateStore.saveConnectionState(CONNECTION_ID, {
    cursor: 'same-title-cursor',
    lastSyncAt: '2026-07-24T10:00:00.000Z',
    songs: {}
  });

  const result = await synchronizer({
    client: clientStub({
      getSong: async () => remote,
      listSongChanges: async () => {
        throw new Error('exact pull must not read the song feed');
      }
    }),
    library,
    stateStore
  }).pullSong(remote.syncId, {
    expectedSyncVersion: remote.syncVersion,
    expectedRevision: remote.revision
  });

  assert.equal(result.pulled, 1);
  assert.equal(
    (await library.read(local.song.id)).revision,
    local.revision,
    'the same-title local family must remain byte-for-byte authoritative'
  );
  assert.match(
    (await library.read(remote.syncId)).source,
    /Import only under the exact remote identity/
  );
  assert.equal(
    (await stateStore.getSongState(
      CONNECTION_ID,
      remote.syncId
    )).localFamilyId,
    remote.syncId
  );
});

test('invalid, offline, and stale exact pulls do not invoke unrelated family recovery', async t => {
  const { library, stateStore } = await workspace(t);
  let recoveries = 0;
  let remoteMode = 'offline';
  const remote = remoteSong({
    syncId: 'recovery-guard-song',
    syncVersion: 3
  });
  const familyImportCoordinator = {
    async recover() {
      recoveries += 1;
    },
    async apply() {
      throw new Error('an unsuccessful exact pull must not import a family');
    }
  };
  const client = clientStub({
    getSong: async () => {
      if (remoteMode === 'offline') {
        throw new CommunityClientError(
          'NETWORK_ERROR',
          'offline',
          { retryable: true }
        );
      }
      return remote;
    }
  });
  const sync = synchronizer({
    client,
    library,
    stateStore,
    familyImportCoordinator
  });

  await assert.rejects(
    sync.pullSong('invalid exact id', {
      expectedSyncVersion: 3,
      expectedRevision: remote.revision
    }),
    error => error.code === 'INVALID_SYNC_ID'
  );
  const offline = await sync.pullSong(remote.syncId, {
    expectedSyncVersion: 3,
    expectedRevision: remote.revision
  });
  assert.equal(offline.status, 'offline');
  remoteMode = 'stale';
  await assert.rejects(
    sync.pullSong(remote.syncId, {
      expectedSyncVersion: 2,
      expectedRevision: 'song:recovery-guard-song:2'
    }),
    error => error.code === 'REMOTE_PRECONDITION_FAILED'
  );

  assert.equal(
    recoveries,
    0,
    'unusable exact attempts must not recover an unrelated durable family transaction'
  );
});

test('exact song pull rejects a changed remote pin before local or state mutation', async t => {
  const { library, stateStore } = await workspace(t);
  const priorLastSyncAt = '2026-07-24T09:00:00.000Z';
  const source = songSource({
    id: 'changed-plan-song',
    title: 'Changed Plan Song'
  });
  const remote = remoteSong({
    syncId: 'changed-plan-song',
    syncVersion: 8,
    syncDocuments: [{
      id: 'changed-plan-song',
      source,
      revision: crypto.createHash('sha256').update(source).digest('hex')
    }]
  });
  await stateStore.saveConnectionState(CONNECTION_ID, {
    cursor: 'unchanged-on-pin-mismatch',
    lastSyncAt: priorLastSyncAt,
    songs: {}
  });
  let writes = 0;
  const client = clientStub({
    getSong: async () => remote,
    listSongChanges: async () => {
      throw new Error('exact pull must not read the song feed');
    },
    createSong: async () => {
      writes += 1;
      return remote;
    },
    updateSong: async () => {
      writes += 1;
      return remote;
    }
  });

  await assert.rejects(
    synchronizer({ client, library, stateStore }).pullSong(
      'changed-plan-song',
      {
        expectedSyncVersion: 7,
        expectedRevision: 'song:changed-plan-song:7'
      }
    ),
    error => error.code === 'REMOTE_PRECONDITION_FAILED'
  );
  assert.equal(writes, 0);
  await assert.rejects(
    library.read('changed-plan-song'),
    error => error.code === 'SONG_NOT_FOUND'
  );
  const state = await stateStore.getConnectionState(CONNECTION_ID);
  assert.equal(state.cursor, 'unchanged-on-pin-mismatch');
  assert.equal(state.lastSyncAt, priorLastSyncAt);
  assert.deepEqual(Object.keys(state.songs), []);
});

test('exact song pull preserves a divergent local edit as a conflict without a Community write', async t => {
  const { library, stateStore } = await workspace(t);
  const baseline = await library.saveSource(songSource({
    id: 'planned-song-conflict',
    title: 'Planned Song Conflict',
    line: 'Original baseline'
  }));
  await stateStore.saveConnectionState(CONNECTION_ID, {
    cursor: 'planned-conflict-cursor',
    songs: {
      [baseline.song.id]: {
        syncId: baseline.song.id,
        localFamilyId: baseline.song.id,
        remoteTitle: baseline.song.title,
        alternateTitles: [],
        syncVersion: 1,
        remoteRevision: `song:${baseline.song.id}:1`,
        documents: {
          [baseline.song.id]: {
            localRevision: baseline.revision,
            remoteRevision: baseline.revision
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
  const edited = await library.saveSource(songSource({
    id: baseline.song.id,
    title: baseline.song.title,
    line: 'Unsynced local wording'
  }), {
    expectedSongId: baseline.song.id,
    expectedRevision: baseline.revision
  });
  const remoteSource = songSource({
    id: baseline.song.id,
    title: baseline.song.title,
    line: 'New Community wording'
  });
  const remote = remoteSong({
    syncId: baseline.song.id,
    syncVersion: 2,
    syncDocuments: [{
      id: baseline.song.id,
      source: remoteSource,
      revision: crypto.createHash('sha256').update(remoteSource).digest('hex')
    }],
    title: baseline.song.title
  });
  let writes = 0;
  const client = clientStub({
    getSong: async () => remote,
    listSongChanges: async () => {
      throw new Error('exact pull must not read the song feed');
    },
    createSong: async () => {
      writes += 1;
      return remote;
    },
    updateSong: async () => {
      writes += 1;
      return remote;
    }
  });

  const result = await synchronizer({
    client,
    library,
    stateStore
  }).pullSong(baseline.song.id, {
    expectedSyncVersion: 2,
    expectedRevision: `song:${baseline.song.id}:2`
  });

  assert.equal(result.conflicts, 1);
  assert.equal(writes, 0);
  assert.equal(
    (await library.read(baseline.song.id)).revision,
    edited.revision
  );
  const state = await stateStore.getSongState(
    CONNECTION_ID,
    baseline.song.id
  );
  assert.equal(state.conflict.code, 'BOTH_CHANGED');
  assert.equal(
    (await stateStore.getConnectionState(CONNECTION_ID)).cursor,
    'planned-conflict-cursor'
  );
});

test('read-only sync never sends a queued conflict demotion', async t => {
  const { library, stateStore } = await workspace(t);
  const local = await library.saveSource(songSource({
    id: 'read-only-conflict',
    title: 'Read Only Conflict',
    line: 'Local wording'
  }));
  const remoteSource = songSource({
    id: local.song.id,
    title: local.song.title,
    line: 'Remote wording'
  });
  const remoteRevision = crypto.createHash('sha256')
    .update(remoteSource)
    .digest('hex');
  await stateStore.saveConnectionState(CONNECTION_ID, {
    songs: {
      [local.song.id]: {
        syncId: local.song.id,
        localFamilyId: local.song.id,
        remoteTitle: local.song.title,
        alternateTitles: [],
        syncVersion: 1,
        remoteRevision: `song:${local.song.id}:1`,
        documents: {
          [local.song.id]: {
            localRevision: local.revision,
            remoteRevision
          }
        },
        visibility: 'public',
        publishAt: null,
        pendingVisibility: {
          visibility: 'private',
          publishAt: null,
          expectedSyncVersion: 1
        },
        archived: false,
        metadataOnly: false,
        lastSyncedAt: NOW,
        conflict: {
          code: 'BOTH_CHANGED',
          detectedAt: NOW,
          localRevision: local.revision,
          remoteRevision: `song:${local.song.id}:1`,
          remoteDocuments: [{
            id: local.song.id,
            source: remoteSource,
            revision: remoteRevision
          }]
        }
      }
    }
  });
  let updates = 0;
  const client = clientStub({
    listSongChanges: async () => ({
      items: [remoteSong({
        syncId: local.song.id,
        syncVersion: 1,
        syncDocuments: [{
          id: local.song.id,
          source: remoteSource,
          revision: remoteRevision
        }],
        visibility: 'public'
      })],
      nextCursor: 'read-only-conflict-cursor',
      hasMore: false
    }),
    updateSong: async () => {
      updates += 1;
      throw new Error('read-only sync must not demote remotely');
    }
  });

  const result = await synchronizer({
    client,
    library,
    stateStore
  }).sync({ allowWrites: false });
  const retained = await stateStore.getSongState(CONNECTION_ID, local.song.id);
  assert.equal(result.pushed, 0);
  assert.equal(updates, 0);
  assert.equal(retained.visibility, 'public');
  assert.equal(retained.pendingVisibility.visibility, 'private');
  assert.equal(retained.conflict.code, 'BOTH_CHANGED');
});

test('an online write-capable retry demotes a queued conflict even when the change page is empty', async t => {
  const { library, stateStore } = await workspace(t);
  const local = await library.saveSource(songSource({
    id: 'retry-conflict-restriction',
    title: 'Retry Conflict Restriction',
    line: 'Local wording'
  }));
  const remoteSource = songSource({
    id: local.song.id,
    title: local.song.title,
    line: 'Remote wording'
  });
  const remoteDocument = {
    id: local.song.id,
    source: remoteSource,
    revision: crypto.createHash('sha256').update(remoteSource).digest('hex')
  };
  await stateStore.saveConnectionState(CONNECTION_ID, {
    songs: {
      [local.song.id]: {
        syncId: local.song.id,
        localFamilyId: local.song.id,
        remoteTitle: local.song.title,
        alternateTitles: [],
        syncVersion: 1,
        remoteRevision: `song:${local.song.id}:1`,
        documents: {
          [local.song.id]: {
            localRevision: local.revision,
            remoteRevision: remoteDocument.revision
          }
        },
        visibility: 'public',
        publishAt: null,
        pendingVisibility: {
          visibility: 'private',
          publishAt: null,
          expectedSyncVersion: 1
        },
        archived: false,
        metadataOnly: false,
        lastSyncedAt: NOW,
        conflict: {
          code: 'BOTH_CHANGED',
          detectedAt: NOW,
          localRevision: local.revision,
          remoteRevision: `song:${local.song.id}:1`,
          remoteSyncVersion: 1,
          remoteDocuments: [remoteDocument]
        }
      }
    }
  });
  const latest = remoteSong({
    syncId: local.song.id,
    syncVersion: 1,
    syncDocuments: [remoteDocument],
    title: local.song.title,
    visibility: 'public'
  });
  const updates = [];
  const client = clientStub({
    listSongChanges: async () => ({
      items: [],
      nextCursor: 'retry-conflict-restriction-cursor',
      hasMore: false
    }),
    getSong: async () => latest,
    updateSong: async input => {
      updates.push(input);
      return remoteSong({
        syncId: input.syncId,
        syncVersion: input.expectedSyncVersion + 1,
        syncDocuments: [remoteDocument],
        title: local.song.title,
        visibility: 'private'
      });
    }
  });

  const result = await synchronizer({ client, library, stateStore }).sync();

  assert.equal(result.pushed, 1);
  assert.equal(result.conflicts, 1);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].expectedSyncVersion, 1);
  const restricted = await stateStore.getSongState(CONNECTION_ID, local.song.id);
  assert.equal(restricted.visibility, 'private');
  assert.equal(restricted.pendingVisibility, null);
  assert.equal(restricted.conflict.code, 'BOTH_CHANGED');
  assert.equal(restricted.conflict.remoteSyncVersion, 2);
});

test('a stale queued restriction demotes the freshly observed public version without choosing content', async t => {
  const { library, stateStore } = await workspace(t);
  const local = await library.saveSource(songSource({
    id: 'fresh-cas-restriction',
    title: 'Fresh CAS Restriction',
    line: 'Local wording'
  }));
  const originalRemoteSource = songSource({
    id: local.song.id,
    title: local.song.title,
    line: 'Original remote wording'
  });
  const originalRemoteDocument = {
    id: local.song.id,
    source: originalRemoteSource,
    revision: crypto.createHash('sha256').update(originalRemoteSource).digest('hex')
  };
  await stateStore.saveConnectionState(CONNECTION_ID, {
    songs: {
      [local.song.id]: {
        syncId: local.song.id,
        localFamilyId: local.song.id,
        remoteTitle: local.song.title,
        alternateTitles: [],
        syncVersion: 1,
        remoteRevision: `song:${local.song.id}:1`,
        documents: {
          [local.song.id]: {
            localRevision: local.revision,
            remoteRevision: originalRemoteDocument.revision
          }
        },
        visibility: 'public',
        publishAt: null,
        pendingVisibility: {
          visibility: 'private',
          publishAt: null,
          expectedSyncVersion: 1
        },
        archived: false,
        metadataOnly: false,
        lastSyncedAt: NOW,
        conflict: {
          code: 'BOTH_CHANGED',
          detectedAt: NOW,
          localRevision: local.revision,
          remoteRevision: `song:${local.song.id}:1`,
          remoteSyncVersion: 1,
          remoteDocuments: [originalRemoteDocument]
        }
      }
    }
  });
  const freshRemoteSource = songSource({
    id: local.song.id,
    title: local.song.title,
    line: 'Fresh remote wording'
  });
  const freshRemoteDocument = {
    id: local.song.id,
    source: freshRemoteSource,
    revision: crypto.createHash('sha256').update(freshRemoteSource).digest('hex')
  };
  const freshRemote = remoteSong({
    syncId: local.song.id,
    syncVersion: 2,
    syncDocuments: [freshRemoteDocument],
    title: local.song.title,
    visibility: 'public'
  });
  const updates = [];
  const client = clientStub({
    listSongChanges: async () => ({
      items: [freshRemote],
      nextCursor: 'fresh-cas-restriction-cursor',
      hasMore: false
    }),
    updateSong: async input => {
      updates.push(input);
      return remoteSong({
        syncId: input.syncId,
        syncVersion: input.expectedSyncVersion + 1,
        syncDocuments: [freshRemoteDocument],
        title: local.song.title,
        visibility: 'private'
      });
    }
  });

  const result = await synchronizer({ client, library, stateStore }).sync();

  assert.equal(result.pushed, 1);
  assert.equal(result.conflicts, 1);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].expectedSyncVersion, 2);
  const restricted = await stateStore.getSongState(CONNECTION_ID, local.song.id);
  assert.equal(restricted.visibility, 'private');
  assert.equal(restricted.pendingVisibility, null);
  assert.equal(restricted.conflict.code, 'BOTH_CHANGED');
  assert.equal(restricted.conflict.remoteSyncVersion, 3);
  assert.equal(
    restricted.conflict.remoteDocuments[0].revision,
    freshRemoteDocument.revision
  );
  assert.equal((await library.read(local.song.id)).revision, local.revision);
});

test('a retryable failure while demoting a stale queued restriction reports offline and keeps the intent', async t => {
  const { library, stateStore } = await workspace(t);
  const local = await library.saveSource(songSource({
    id: 'offline-stale-restriction',
    title: 'Offline Stale Restriction',
    line: 'Local wording'
  }));
  const originalRemoteSource = songSource({
    id: local.song.id,
    title: local.song.title,
    line: 'Original remote wording'
  });
  const originalRemoteDocument = {
    id: local.song.id,
    source: originalRemoteSource,
    revision: crypto.createHash('sha256').update(originalRemoteSource).digest('hex')
  };
  await stateStore.saveConnectionState(CONNECTION_ID, {
    songs: {
      [local.song.id]: {
        syncId: local.song.id,
        localFamilyId: local.song.id,
        remoteTitle: local.song.title,
        alternateTitles: [],
        syncVersion: 1,
        remoteRevision: `song:${local.song.id}:1`,
        documents: {
          [local.song.id]: {
            localRevision: local.revision,
            remoteRevision: originalRemoteDocument.revision
          }
        },
        visibility: 'public',
        publishAt: null,
        pendingVisibility: {
          visibility: 'private',
          publishAt: null,
          expectedSyncVersion: 1
        },
        archived: false,
        metadataOnly: false,
        lastSyncedAt: NOW,
        conflict: {
          code: 'BOTH_CHANGED',
          detectedAt: NOW,
          localRevision: local.revision,
          remoteRevision: `song:${local.song.id}:1`,
          remoteSyncVersion: 1,
          remoteDocuments: [originalRemoteDocument]
        }
      }
    }
  });
  const freshRemoteSource = songSource({
    id: local.song.id,
    title: local.song.title,
    line: 'Fresh remote wording'
  });
  const freshRemoteDocument = {
    id: local.song.id,
    source: freshRemoteSource,
    revision: crypto.createHash('sha256').update(freshRemoteSource).digest('hex')
  };
  const client = clientStub({
    listSongChanges: async () => ({
      items: [remoteSong({
        syncId: local.song.id,
        syncVersion: 2,
        syncDocuments: [freshRemoteDocument],
        title: local.song.title,
        visibility: 'public'
      })],
      nextCursor: 'offline-stale-restriction-cursor',
      hasMore: false
    }),
    updateSong: async () => {
      throw new CommunityClientError('NETWORK_ERROR', 'offline', { retryable: true });
    }
  });

  const result = await synchronizer({ client, library, stateStore }).sync();

  assert.equal(result.status, 'offline');
  assert.equal(result.pushed, 0);
  assert.equal(result.warnings.at(-1).code, 'NETWORK_ERROR');
  const retained = await stateStore.getSongState(CONNECTION_ID, local.song.id);
  assert.equal(retained.syncVersion, 1);
  assert.equal(retained.visibility, 'public');
  assert.equal(retained.pendingVisibility.visibility, 'private');
  assert.equal(retained.pendingVisibility.expectedSyncVersion, 1);
  assert.equal(retained.conflict.code, 'BOTH_CHANGED');
  assert.equal(retained.conflict.remoteSyncVersion, 1);
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

test('a conflicted member-visible song can be restricted without choosing either content copy', async t => {
  const { library, stateStore } = await workspace(t);
  const local = await library.saveSource(songSource({
    id: 'restrict-conflict',
    title: 'Restrict Conflict',
    line: 'Local wording'
  }));
  const remoteSource = songSource({
    id: local.song.id,
    title: local.song.title,
    line: 'Remote wording'
  });
  const remoteDocument = {
    id: local.song.id,
    source: remoteSource,
    revision: crypto.createHash('sha256').update(remoteSource).digest('hex')
  };
  let remote = remoteSong({
    syncId: local.song.id,
    syncVersion: 1,
    syncDocuments: [remoteDocument],
    visibility: 'public'
  });
  const substitutedSource = songSource({
    id: local.song.id,
    title: local.song.title,
    line: 'Substituted during restriction'
  });
  const substitutedDocument = {
    id: local.song.id,
    source: substitutedSource,
    revision: crypto.createHash('sha256').update(substitutedSource).digest('hex')
  };
  let responseKind = 'substituted';
  const updates = [];
  const client = clientStub({
    listSongChanges: async () => ({
      items: [remote],
      nextCursor: 'restrict-conflict-cursor',
      hasMore: false
    }),
    updateSong: async input => {
      updates.push(input);
      assert.equal(input.syncDocuments, undefined);
      remote = remoteSong({
        syncId: local.song.id,
        syncVersion: input.expectedSyncVersion + 1,
        syncDocuments: [
          responseKind === 'substituted' ? substitutedDocument : remoteDocument
        ],
        visibility: input.visibility,
        publishAt: input.publishAt
      });
      return remote;
    }
  });
  const sync = synchronizer({ client, library, stateStore });
  await sync.sync();
  const conflict = await stateStore.getSongState(CONNECTION_ID, local.song.id);
  assert.ok(conflict.conflict);

  await assert.rejects(
    sync.syncSong(local.song.id, {
      visibilityForSong: () => ({
        visibility: 'private',
        publishAt: null,
        expectedSyncVersion: conflict.syncVersion
      })
    }),
    error => error.code === 'REMOTE_CONTENT_MISMATCH'
  );
  const rejected = await stateStore.getSongState(CONNECTION_ID, local.song.id);
  assert.equal(rejected.syncVersion, conflict.syncVersion);
  assert.equal(rejected.pendingVisibility.visibility, 'private');
  assert.equal(
    rejected.conflict.remoteDocuments[0].revision,
    remoteDocument.revision
  );

  responseKind = 'valid';
  remote = remoteSong({
    syncId: local.song.id,
    syncVersion: 1,
    syncDocuments: [remoteDocument],
    visibility: 'public'
  });
  const result = await sync.syncSong(local.song.id);
  assert.equal(result.pushed, 1);
  assert.equal(updates.length, 2);
  const restricted = await stateStore.getSongState(CONNECTION_ID, local.song.id);
  assert.equal(restricted.visibility, 'private');
  assert.equal(restricted.publishAt, null);
  assert.equal(restricted.pendingVisibility, null);
  assert.equal(restricted.conflict.code, conflict.conflict.code);
  assert.equal((await library.read(local.song.id)).revision, local.revision);
});

test('a stale conflict restriction clears when the fresh server state is already private', async t => {
  const { library, stateStore } = await workspace(t);
  const local = await library.saveSource(songSource({
    id: 'already-restricted-conflict',
    title: 'Already Restricted Conflict',
    line: 'Local wording'
  }));
  const remoteSource = songSource({
    id: local.song.id,
    title: local.song.title,
    line: 'Remote wording'
  });
  const remoteDocument = {
    id: local.song.id,
    source: remoteSource,
    revision: crypto.createHash('sha256').update(remoteSource).digest('hex')
  };
  let remote = remoteSong({
    syncId: local.song.id,
    syncVersion: 1,
    syncDocuments: [remoteDocument],
    visibility: 'public'
  });
  let updates = 0;
  const client = clientStub({
    listSongChanges: async () => ({
      items: [remote],
      nextCursor: 'already-restricted-conflict-cursor',
      hasMore: false
    }),
    updateSong: async () => {
      updates += 1;
      throw new Error('an already-private remote must not be rewritten');
    }
  });
  const sync = synchronizer({ client, library, stateStore });
  await sync.sync();
  const conflict = await stateStore.getSongState(CONNECTION_ID, local.song.id);
  remote = remoteSong({
    syncId: local.song.id,
    syncVersion: 2,
    syncDocuments: [remoteDocument],
    visibility: 'private'
  });

  const result = await sync.syncSong(local.song.id, {
    visibilityForSong: () => ({
      visibility: 'private',
      publishAt: null,
      expectedSyncVersion: conflict.syncVersion
    })
  });

  const restricted = await stateStore.getSongState(CONNECTION_ID, local.song.id);
  assert.equal(result.pushed, 0);
  assert.equal(updates, 0);
  assert.equal(restricted.visibility, 'private');
  assert.equal(restricted.pendingVisibility, null);
  assert.equal(restricted.conflict.code, conflict.conflict.code);
});

test('legacy scheduled queue stages privately and only an explicit online review transaction shares', async t => {
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
  assert.equal(online.status, 'needs-review');
  assert.equal(online.reviewRequired, 1);
  assert.equal(online.pushed, 1);
  assert.equal(creates.length, 1);
  assert.equal(creates[0].visibility, 'private');
  assert.equal(creates[0].publishAt, null);
  assert.equal(
    online.warnings[0].code,
    'SONG_MEMBER_SHARING_REVIEW_REQUIRED'
  );
  assert.equal(
    (await stateStore.getSongState(CONNECTION_ID, local.song.id))
      .pendingVisibility,
    null,
    'an old local member-visible queue is not retained as authority'
  );

  const reviewedSync = synchronizer({
    client: onlineClient,
    library,
    stateStore
  });
  const reviewed = await applyMemberSharing(
    reviewedSync,
    stateStore,
    library,
    local.song.id,
    [local.song.id],
    {
      visibility: 'scheduled-public',
      publishAt: '2026-07-27T17:00:00.000Z',
      expectedSyncVersion: 1
    }
  );
  assert.equal(reviewed.status, 'synced');
  assert.equal(reviewed.reviewRequired, 0);
  assert.equal(reviewed.pushed, 1);
  assert.equal(creates.length, 1);
  const shared = await stateStore.getSongState(
    CONNECTION_ID,
    local.song.id
  );
  assert.equal(shared.visibility, 'scheduled-public');
  assert.equal(shared.publishAt, '2026-07-27T17:00:00.000Z');
  assert.equal(shared.memberSharing.songSyncVersion, 2);
});

test('Community, not the workstation, decides whether a civil review date covers a schedule', async t => {
  const { library, stateStore } = await workspace(t);
  const local = await library.saveSource(songSource({
    id: 'scheduled-create-window',
    title: 'Scheduled Create Window'
  }));
  const creates = [];
  const client = clientStub({
    createSong: async input => {
      creates.push(input);
      return remoteSong({
        syncId: input.syncId,
        syncDocuments: input.syncDocuments,
        visibility: input.visibility,
        publishAt: input.publishAt
      });
    },
    shareSongWithMembers: async input => {
      assert.equal(input.review.validUntil, '2026-07-26');
      assert.equal(input.publishAt, '2026-07-28T17:00:00.000Z');
      throw new CommunityClientError(
        'BAD_REQUEST',
        'Community review boundary does not cover that schedule.'
      );
    }
  });
  const sync = synchronizer({
    client,
    library,
    stateStore
  });
  await assert.rejects(
    applyMemberSharing(
      sync,
      stateStore,
      library,
      local.song.id,
      [local.song.id],
      {
        visibility: 'scheduled-public',
        publishAt: '2026-07-28T17:00:00.000Z',
        validUntil: '2026-07-26'
      }
    ),
    error => error.code === 'BAD_REQUEST'
  );
  assert.equal(creates.length, 1);
  assert.equal(creates[0].visibility, 'private');
  assert.equal(
    (await stateStore.getSongState(CONNECTION_ID, local.song.id)).visibility,
    'private'
  );
});

test('a visibility-only member-sharing response must echo the exact reviewed documents', async t => {
  const { library, stateStore } = await workspace(t);
  const local = await library.saveSource(songSource({
    id: 'visibility-echo',
    title: 'Visibility Echo',
    line: 'Reviewed content'
  }));
  const substitutedSource = songSource({
    id: local.song.id,
    title: local.song.title,
    line: 'Unreviewed substituted content'
  });
  const substitutedDocument = {
    id: local.song.id,
    source: substitutedSource,
    revision: crypto.createHash('sha256').update(substitutedSource).digest('hex')
  };
  let responseKind = 'omitted';
  const client = clientStub({
    createSong: async input => remoteSong({
      syncId: input.syncId,
      syncVersion: 1,
      syncDocuments: input.syncDocuments,
      title: local.song.title,
      visibility: 'private'
    }),
    shareSongWithMembers: async input => {
      const song = remoteSong({
        syncId: input.syncId,
        syncVersion: input.expectedSyncVersion + 1,
        syncDocuments: responseKind === 'omitted' ? [] : [substitutedDocument],
        title: local.song.title,
        visibility: 'public'
      });
      song.memberSharing = {
        receiptRevision: 'receipt-substitution',
        songSyncVersion: song.syncVersion
      };
      return {
        receipt: {
          receiptRevision: 'receipt-substitution',
          songSyncVersion: song.syncVersion
        },
        song
      };
    }
  });
  const sync = synchronizer({ client, library, stateStore });
  await sync.sync();

  await assert.rejects(
    applyMemberSharing(
      sync,
      stateStore,
      library,
      local.song.id,
      [local.song.id],
      { expectedSyncVersion: 1 }
    ),
    error => error.code === 'REMOTE_CONTENT_MISMATCH'
  );
  responseKind = 'substituted';
  await assert.rejects(
    applyMemberSharing(
      sync,
      stateStore,
      library,
      local.song.id,
      [local.song.id],
      { expectedSyncVersion: 1 }
    ),
    error => error.code === 'REMOTE_CONTENT_MISMATCH'
  );

  const retained = await stateStore.getSongState(CONNECTION_ID, local.song.id);
  assert.equal(retained.syncVersion, 1);
  assert.equal(retained.visibility, 'private');
  assert.equal(retained.pendingVisibility, null);
  assert.equal(retained.documents[local.song.id].remoteRevision, local.revision);
});

test('background edits of a scheduled family stage the new exact content privately', async t => {
  const { library, stateStore } = await workspace(t);
  const baseline = await library.saveSource(songSource({
    id: 'scheduled-update-window',
    title: 'Scheduled Update Window',
    line: 'Scheduled baseline'
  }));
  await stateStore.saveConnectionState(CONNECTION_ID, {
    cursor: 'scheduled-update-baseline',
    lastSyncAt: NOW,
    songs: {
      [baseline.song.id]: {
        syncId: baseline.song.id,
        localFamilyId: baseline.song.id,
        remoteTitle: baseline.song.title,
        alternateTitles: [],
        syncVersion: 4,
        remoteRevision: `song:${baseline.song.id}:4`,
        documents: {
          [baseline.song.id]: {
            localRevision: baseline.revision,
            remoteRevision: baseline.revision
          }
        },
        visibility: 'scheduled-public',
        publishAt: '2026-07-28T17:00:00.000Z',
        pendingVisibility: null,
        archived: false,
        metadataOnly: false,
        lastSyncedAt: NOW,
        conflict: null
      }
    }
  });
  const changed = await library.saveSource(songSource({
    id: baseline.song.id,
    title: baseline.song.title,
    line: 'Scheduled local edit'
  }), {
    expectedSongId: baseline.song.id,
    expectedRevision: baseline.revision
  });
  let updates = 0;
  const client = clientStub({
    listSongChanges: async () => ({
      items: [remoteSong({
        syncId: baseline.song.id,
        syncVersion: 4,
        syncDocuments: [{
          id: baseline.song.id,
          source: baseline.source,
          revision: baseline.revision
        }],
        title: baseline.song.title,
        visibility: 'scheduled-public',
        publishAt: '2026-07-28T17:00:00.000Z'
      })],
      nextCursor: 'scheduled-update-final',
      hasMore: false
    }),
    updateSong: async input => {
      updates += 1;
      return remoteSong({
        syncId: input.syncId,
        syncVersion: input.expectedSyncVersion + 1,
        syncDocuments: input.syncDocuments,
        title: baseline.song.title,
        visibility: 'private',
        publishAt: null
      });
    }
  });

  const result = await synchronizer({
    client,
    library,
    stateStore
  }).syncSong(baseline.song.id);

  assert.equal(result.status, 'needs-review');
  assert.equal(result.reviewRequired, 1);
  assert.equal(result.pushed, 1);
  assert.equal(updates, 1);
  assert.equal(
    (await stateStore.getSongState(CONNECTION_ID, baseline.song.id)).visibility,
    'private'
  );
  assert.equal((await library.read(baseline.song.id)).revision, changed.revision);
});

test('workstation clock does not decide the Community civil review boundary', async t => {
  const { library, stateStore } = await workspace(t);
  const local = await library.saveSource(songSource({
    id: 'fresh-review-clock',
    title: 'Fresh Review Clock'
  }));
  let creates = 0;
  const client = clientStub({
    createSong: async input => {
      creates += 1;
      return remoteSong({
        syncId: input.syncId,
        syncDocuments: input.syncDocuments,
        visibility: input.visibility
      });
    }
  });

  const sync = synchronizer({
    client,
    library,
    stateStore,
    now: () => new Date('2026-07-26T12:00:00.000Z')
  });
  const result = await applyMemberSharing(
    sync,
    stateStore,
    library,
    local.song.id,
    [local.song.id],
    { validUntil: '2026-07-25' }
  );

  assert.equal(result.status, 'synced');
  assert.equal(result.reviewRequired, 0);
  assert.equal(creates, 1);
  assert.equal(
    (await stateStore.getSongState(CONNECTION_ID, local.song.id)).visibility,
    'public'
  );
});

test('a local review alone never promotes a privately staged new family', async t => {
  const { library, stateStore } = await workspace(t);
  const local = await library.saveSource(songSource({
    id: 'public-new-family',
    title: 'Public New Family'
  }));
  await stateStore.setSongVisibility(CONNECTION_ID, local.song.id, {
    visibility: 'public'
  });
  const creates = [];
  const client = clientStub({
    createSong: async input => {
      creates.push(input);
      return remoteSong({
        syncId: input.syncId,
        syncDocuments: input.syncDocuments,
        visibility: input.visibility
      });
    }
  });
  const sync = synchronizer({ client, library, stateStore });

  const blocked = await sync.syncSong(local.song.id);
  assert.equal(blocked.status, 'needs-review');
  assert.equal(blocked.reviewRequired, 1);
  assert.equal(blocked.pushed, 1);
  assert.equal(creates.length, 1);
  assert.equal(creates[0].visibility, 'private');

  const { familyRevision } = await confirmMemberSharingReview(
    stateStore,
    library,
    local.song.id,
    [local.song.id]
  );
  assert.equal(
    (await stateStore.getSongSharingReview(CONNECTION_ID, local.song.id))
      .familyRevision,
    familyRevision
  );

  const background = await sync.syncSong(local.song.id);
  assert.equal(background.status, 'synced');
  assert.equal(background.pushed, 0);
  assert.equal(creates.length, 1);
  assert.equal(
    (await stateStore.getSongState(CONNECTION_ID, local.song.id)).visibility,
    'private'
  );

  const allowed = await applyMemberSharing(
    sync,
    stateStore,
    library,
    local.song.id,
    [local.song.id],
    { expectedSyncVersion: 1 }
  );
  assert.equal(allowed.status, 'synced');
  assert.equal(allowed.pushed, 1);
  assert.equal(
    (await stateStore.getSongState(CONNECTION_ID, local.song.id)).visibility,
    'public'
  );
});

test('adding or editing a translation stales review and blocks a public family update', async t => {
  const { library, stateStore } = await workspace(t);
  const root = await library.saveSource(songSource({
    id: 'reviewed-family',
    title: 'Reviewed Family',
    line: 'Reviewed original'
  }));
  const baselineDocuments = await localDocuments(library, [root.song.id]);
  await stateStore.saveConnectionState(CONNECTION_ID, {
    cursor: 'reviewed-family-baseline',
    lastSyncAt: NOW,
    songs: {
      [root.song.id]: {
        syncId: root.song.id,
        localFamilyId: root.song.id,
        remoteTitle: root.song.title,
        alternateTitles: [],
        syncVersion: 4,
        remoteRevision: `song:${root.song.id}:4`,
        documents: {
          [root.song.id]: {
            localRevision: root.revision,
            remoteRevision: root.revision
          }
        },
        visibility: 'public',
        publishAt: null,
        pendingVisibility: null,
        archived: false,
        metadataOnly: false,
        lastSyncedAt: NOW,
        conflict: null
      }
    }
  });
  const rootOnlyReview = await confirmMemberSharingReview(
    stateStore,
    library,
    root.song.id,
    [root.song.id]
  );
  const translation = await library.saveSource(songSource({
    id: 'reviewed-family-ru',
    title: 'Проверенная семья',
    language: 'ru',
    translationOf: root.song.id,
    line: 'First translation'
  }), { expectedRevision: null });
  let remote = remoteSong({
    syncId: root.song.id,
    syncVersion: 4,
    syncDocuments: baselineDocuments,
    title: root.song.title,
    visibility: 'public'
  });
  const updates = [];
  let changeCursor = 0;
  const client = clientStub({
    listSongChanges: async () => ({
      items: [remote],
      nextCursor: `reviewed-family-change-${changeCursor += 1}`,
      hasMore: false
    }),
    updateSong: async input => {
      updates.push(input);
      remote = remoteSong({
        syncId: root.song.id,
        syncVersion: input.expectedSyncVersion + 1,
        syncDocuments: input.syncDocuments,
        title: root.song.title,
        visibility: input.visibility || remote.visibility,
        publishAt: input.publishAt || null
      });
      return remote;
    }
  });
  const sync = synchronizer({ client, library, stateStore });

  const addedTranslation = await sync.sync();
  assert.equal(addedTranslation.status, 'needs-review');
  assert.equal(addedTranslation.reviewRequired, 1);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].visibility, 'private');
  assert.match(addedTranslation.warnings[0].message, /changed after its sharing review/i);
  assert.notEqual(
    await localFamilyRevision(
      library,
      [root.song.id, translation.song.id]
    ),
    rootOnlyReview.familyRevision
  );

  const familyReview = await confirmMemberSharingReview(
    stateStore,
    library,
    root.song.id,
    [root.song.id, translation.song.id]
  );
  const changedTranslation = await library.saveSource(songSource({
    id: translation.song.id,
    title: translation.song.title,
    language: 'ru',
    translationOf: root.song.id,
    line: 'Edited translation'
  }), {
    expectedSongId: translation.song.id,
    expectedRevision: translation.revision
  });
  const editedTranslation = await sync.sync();
  assert.equal(editedTranslation.status, 'synced');
  assert.equal(editedTranslation.reviewRequired, 0);
  assert.equal(updates.length, 2);
  assert.equal(remote.visibility, 'private');
  assert.notEqual(
    await localFamilyRevision(
      library,
      [root.song.id, changedTranslation.song.id]
    ),
    familyReview.familyRevision
  );

  const allowed = await applyMemberSharing(
    sync,
    stateStore,
    library,
    root.song.id,
    [root.song.id, changedTranslation.song.id],
    { expectedSyncVersion: 6 }
  );
  assert.equal(allowed.status, 'synced');
  assert.equal(allowed.reviewRequired, 0);
  assert.equal(updates.length, 2);
  assert.deepEqual(
    updates[1].syncDocuments.map(document => document.id),
    [root.song.id, changedTranslation.song.id]
  );
  assert.equal(
    updates[1].syncDocuments[1].revision,
    changedTranslation.revision
  );
  assert.equal(
    (await stateStore.getSongState(CONNECTION_ID, root.song.id)).visibility,
    'public'
  );
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

test('public-to-private local changes demote before uploading unreviewed documents', async t => {
  const { library, stateStore } = await workspace(t);
  const baseline = await library.saveSource(songSource({
    id: 'demote-before-private-update',
    title: 'Demote Before Private Update',
    line: 'Public baseline'
  }));
  const baselineDocuments = await localDocuments(library, [baseline.song.id]);
  await stateStore.saveConnectionState(CONNECTION_ID, {
    cursor: 'demotion-baseline',
    lastSyncAt: NOW,
    songs: {
      [baseline.song.id]: {
        syncId: baseline.song.id,
        localFamilyId: baseline.song.id,
        remoteTitle: baseline.song.title,
        alternateTitles: [],
        syncVersion: 4,
        remoteRevision: `song:${baseline.song.id}:4`,
        documents: {
          [baseline.song.id]: {
            localRevision: baseline.revision,
            remoteRevision: baseline.revision
          }
        },
        visibility: 'public',
        publishAt: null,
        pendingVisibility: null,
        archived: false,
        metadataOnly: false,
        lastSyncedAt: NOW,
        conflict: null
      }
    }
  });
  await stateStore.setSongVisibility(CONNECTION_ID, baseline.song.id, {
    visibility: 'private',
    expectedSyncVersion: 4
  });
  const changed = await library.saveSource(songSource({
    id: baseline.song.id,
    title: baseline.song.title,
    line: 'Unreviewed private edit'
  }), {
    expectedSongId: baseline.song.id,
    expectedRevision: baseline.revision
  });
  let remote = remoteSong({
    syncId: baseline.song.id,
    syncVersion: 4,
    syncDocuments: baselineDocuments,
    title: baseline.song.title,
    visibility: 'public'
  });
  const updates = [];
  const client = clientStub({
    listSongChanges: async () => ({
      items: [remote],
      nextCursor: `demotion-${remote.syncVersion}`,
      hasMore: false
    }),
    updateSong: async input => {
      updates.push(input);
      if (updates.length === 1) {
        assert.equal(input.visibility, 'private');
        assert.equal(Object.hasOwn(input, 'syncDocuments'), false);
        remote = remoteSong({
          syncId: baseline.song.id,
          syncVersion: 5,
          syncDocuments: baselineDocuments,
          title: baseline.song.title,
          visibility: 'private'
        });
      } else {
        assert.equal(input.visibility, undefined);
        assert.ok(Array.isArray(input.syncDocuments));
        remote = remoteSong({
          syncId: baseline.song.id,
          syncVersion: 6,
          syncDocuments: input.syncDocuments,
          title: baseline.song.title,
          visibility: 'private'
        });
      }
      return remote;
    }
  });

  const result = await synchronizer({ client, library, stateStore }).sync();
  assert.equal(result.status, 'synced');
  assert.equal(result.reviewRequired, 0);
  assert.equal(updates.length, 2);
  assert.equal(updates[0].expectedSyncVersion, 4);
  assert.equal(updates[1].expectedSyncVersion, 5);
  assert.equal(updates[1].syncDocuments[0].revision, changed.revision);
  const savedState = await stateStore.getSongState(
    CONNECTION_ID,
    baseline.song.id
  );
  assert.equal(savedState.visibility, 'private');
  assert.equal(savedState.syncVersion, 6);
  assert.equal(
    savedState.documents[baseline.song.id].localRevision,
    changed.revision
  );
});

test('a failed public-to-private demotion response cannot be followed by a content write', async t => {
  const { library, stateStore } = await workspace(t);
  const baseline = await library.saveSource(songSource({
    id: 'failed-demotion',
    title: 'Failed Demotion',
    line: 'Public baseline'
  }));
  await stateStore.saveConnectionState(CONNECTION_ID, {
    cursor: 'failed-demotion-baseline',
    lastSyncAt: NOW,
    songs: {
      [baseline.song.id]: {
        syncId: baseline.song.id,
        localFamilyId: baseline.song.id,
        remoteTitle: baseline.song.title,
        alternateTitles: [],
        syncVersion: 6,
        remoteRevision: `song:${baseline.song.id}:6`,
        documents: {
          [baseline.song.id]: {
            localRevision: baseline.revision,
            remoteRevision: baseline.revision
          }
        },
        visibility: 'public',
        publishAt: null,
        pendingVisibility: null,
        archived: false,
        metadataOnly: false,
        lastSyncedAt: NOW,
        conflict: null
      }
    }
  });
  await stateStore.setSongVisibility(CONNECTION_ID, baseline.song.id, {
    visibility: 'private',
    expectedSyncVersion: 6
  });
  await library.saveSource(songSource({
    id: baseline.song.id,
    title: baseline.song.title,
    line: 'Unreviewed content must stay local'
  }), {
    expectedSongId: baseline.song.id,
    expectedRevision: baseline.revision
  });
  const baselineDocuments = [{
    id: baseline.song.id,
    source: baseline.source,
    revision: baseline.revision
  }];
  let remote = remoteSong({
    syncId: baseline.song.id,
    syncVersion: 6,
    syncDocuments: baselineDocuments,
    title: baseline.song.title,
    visibility: 'public'
  });
  const updates = [];
  const client = clientStub({
    listSongChanges: async () => ({
      items: [remote],
      nextCursor: 'failed-demotion-final',
      hasMore: false
    }),
    updateSong: async input => {
      updates.push(input);
      remote = remoteSong({
        syncId: baseline.song.id,
        syncVersion: input.expectedSyncVersion + 1,
        syncDocuments: baselineDocuments,
        title: baseline.song.title,
        visibility: 'public',
        publishAt: null
      });
      return remote;
    }
  });

  try {
    await synchronizer({ client, library, stateStore }).syncSong(baseline.song.id);
  } catch (_error) {
    // Returning an error is an acceptable fail-closed outcome.
  }

  assert.equal(updates.length, 1, 'no content write may follow an unconfirmed demotion');
  assert.equal(updates[0].visibility, 'private');
  assert.equal(updates[0].publishAt, null);
  assert.equal(Object.hasOwn(updates[0], 'syncDocuments'), false);
});

test('a Community family pull is invisible to current readers until every pointer is committed', async t => {
  const {
    library,
    stateStore,
    recoveryAuthority
  } = await workspace(t);
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
  const remoteDocuments = [
    songSource({
      id: 'atomic-root',
      title: 'Atomic Root',
      line: 'Remote original'
    }),
    songSource({
      id: 'atomic-ru',
      title: 'Атомний',
      language: 'ru',
      translationOf: 'atomic-root',
      line: 'Remote translation'
    })
  ].map(source => ({
    id: /id: ([^\n]+)/.exec(source)[1],
    source,
    revision: crypto.createHash('sha256').update(source).digest('hex'),
    song: parseSongDocument(source)
  }));
  let observer = null;
  let observerSettled = false;
  const coordinator = new CommunitySongFamilyImportCoordinator({
    rootPath: library.rootPath,
    songLibrary: library,
    recoveryAuthority,
    clock: () => new Date(NOW),
    async onPhase(phase) {
      if (phase === 'member-1-promoted') {
        observer = Promise.all([
          library.read('atomic-root'),
          library.read('atomic-ru')
        ]).finally(() => {
          observerSettled = true;
        });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(observerSettled, false);
      }
      if (phase === 'family-verified') {
        assert.equal(observerSettled, false);
      }
    }
  });
  const sync = synchronizer({
    client: clientStub(),
    library,
    stateStore,
    familyImportCoordinator: coordinator
  });

  await sync._applyRemoteDocumentsAtomically(remoteDocuments, null);
  const observed = await observer;
  assert.match(observed[0].source, /Remote original/);
  assert.match(observed[1].source, /Remote translation/);
  assert.notEqual(observed[0].revision, original.revision);
  assert.notEqual(observed[1].revision, translation.revision);
});

test('an interrupted Community family pull fails closed and rolls forward after restart', async t => {
  const {
    library,
    stateStore,
    recoveryAuthority
  } = await workspace(t);
  const original = await library.saveSource(songSource({
    id: 'restart-atomic-root',
    title: 'Restart Atomic Root',
    line: 'Local original'
  }));
  const translation = await library.saveSource(songSource({
    id: 'restart-atomic-ru',
    title: 'Перезапуск',
    language: 'ru',
    translationOf: 'restart-atomic-root',
    line: 'Local translation'
  }), { expectedRevision: null });
  const remoteDocuments = [
    songSource({
      id: 'restart-atomic-root',
      title: 'Restart Atomic Root',
      line: 'Remote original'
    }),
    songSource({
      id: 'restart-atomic-ru',
      title: 'Перезапуск',
      language: 'ru',
      translationOf: 'restart-atomic-root',
      line: 'Remote translation'
    })
  ].map(source => ({
    id: /id: ([^\n]+)/.exec(source)[1],
    source,
    revision: crypto.createHash('sha256').update(source).digest('hex'),
    song: parseSongDocument(source)
  }));
  const interrupted = new CommunitySongFamilyImportCoordinator({
    rootPath: library.rootPath,
    songLibrary: library,
    recoveryAuthority,
    onPhase(phase) {
      if (phase === 'member-1-promoted') {
        throw new Error('simulated process interruption');
      }
    }
  });
  const sync = synchronizer({
    client: clientStub(),
    library,
    stateStore,
    familyImportCoordinator: interrupted
  });

  await assert.rejects(
    sync._applyRemoteDocumentsAtomically(remoteDocuments, null),
    error => error.code === 'REMOTE_IMPORT_RECOVERY_REQUIRED'
  );
  await assert.rejects(
    library.read('restart-atomic-root'),
    error => error.code === 'SONG_FAMILY_RECOVERY_REQUIRED'
  );
  assert.equal(
    (await new DurableFamilyJournal({
      rootPath: library.rootPath
    }).read()).clear,
    false
  );

  const restartedAuthority = Symbol('restarted-community-family-import');
  const restartedLibrary = new LocalSongLibrary({
    rootPath: library.rootPath,
    familyRecoveryAuthority: restartedAuthority
  });
  const restarted = new CommunitySongFamilyImportCoordinator({
    rootPath: library.rootPath,
    songLibrary: restartedLibrary,
    recoveryAuthority: restartedAuthority
  });
  const promotedPointerPath = path.join(
    library.rootPath,
    idStorageKey('restart-atomic-root'),
    'current.json'
  );
  const promotedPointerBytes = await fs.readFile(promotedPointerPath);
  const detachedPointer = JSON.parse(promotedPointerBytes.toString('utf8'));
  detachedPointer.updatedAt = '2026-07-25T12:00:01.000Z';
  await fs.writeFile(
    promotedPointerPath,
    `${JSON.stringify(detachedPointer, null, 2)}\n`
  );
  await assert.rejects(
    restarted.recover(),
    error => error.code === 'COMMUNITY_FAMILY_IMPORT_RECOVERY_REQUIRED'
  );
  await fs.writeFile(promotedPointerPath, promotedPointerBytes);
  const journalPath = path.join(library.rootPath, FAMILY_JOURNAL_FILE);
  const durableJournalBytes = await fs.readFile(journalPath);
  const corruptHandle = await fs.open(journalPath, 'r+');
  try {
    const byte = Buffer.alloc(1);
    const offset = SLOT_BYTES + SLOT_HEADER_BYTES;
    await corruptHandle.read(byte, 0, 1, offset);
    byte[0] ^= 0xff;
    await corruptHandle.write(byte, 0, 1, offset);
    await corruptHandle.sync();
  } finally {
    await corruptHandle.close();
  }
  await assert.rejects(
    restarted.recover(),
    error => error.code === 'COMMUNITY_FAMILY_IMPORT_JOURNAL_INVALID'
  );
  await fs.writeFile(journalPath, durableJournalBytes);
  await fs.unlink(journalPath);
  await assert.rejects(
    restartedLibrary.read('restart-atomic-root'),
    error => error.code === 'SONG_FAMILY_RECOVERY_REQUIRED'
  );
  await assert.rejects(
    restarted.recover(),
    error => error.code === 'COMMUNITY_FAMILY_IMPORT_JOURNAL_INVALID'
  );
  await fs.writeFile(journalPath, durableJournalBytes, { mode: 0o600 });
  const recovery = await restarted.recover();
  assert.equal(recovery.handled, true);
  assert.equal(recovery.recovered, true);
  assert.match(
    (await restartedLibrary.read('restart-atomic-root')).source,
    /Remote original/
  );
  assert.match(
    (await restartedLibrary.read('restart-atomic-ru')).source,
    /Remote translation/
  );
  assert.notEqual(
    (await restartedLibrary.read('restart-atomic-root')).revision,
    original.revision
  );
  assert.notEqual(
    (await restartedLibrary.read('restart-atomic-ru')).revision,
    translation.revision
  );
  assert.equal(
    (await new DurableFamilyJournal({
      rootPath: library.rootPath
    }).read()).clear,
    true
  );
});

test('Community recovery rejects a re-signed member vector detached from its pre-import snapshot', async t => {
  const {
    library,
    stateStore,
    recoveryAuthority
  } = await workspace(t);
  const root = await library.saveSource(songSource({
    id: 'tampered-import-root',
    title: 'Tampered Import',
    line: 'Local root'
  }));
  const translation = await library.saveSource(songSource({
    id: 'tampered-import-ru',
    title: 'Подмена импорта',
    language: 'ru',
    translationOf: 'tampered-import-root',
    line: 'Local translation'
  }), { expectedRevision: null });
  const remoteDocuments = [
    songSource({
      id: 'tampered-import-root',
      title: 'Tampered Import',
      line: 'Remote root'
    }),
    songSource({
      id: 'tampered-import-ru',
      title: 'Подмена импорта',
      language: 'ru',
      translationOf: 'tampered-import-root',
      line: 'Remote translation'
    })
  ].map(source => ({
    id: /id: ([^\n]+)/.exec(source)[1],
    source,
    revision: crypto.createHash('sha256').update(source).digest('hex'),
    song: parseSongDocument(source)
  }));
  const interrupted = new CommunitySongFamilyImportCoordinator({
    rootPath: library.rootPath,
    songLibrary: library,
    recoveryAuthority,
    onPhase(phase) {
      if (phase === 'journal-written') {
        throw new Error('stop before pointer promotion');
      }
    }
  });
  const sync = synchronizer({
    client: clientStub(),
    library,
    stateStore,
    familyImportCoordinator: interrupted
  });
  await assert.rejects(
    sync._applyRemoteDocumentsAtomically(remoteDocuments, null),
    /stop before pointer promotion/
  );

  const durable = new DurableFamilyJournal({
    rootPath: library.rootPath
  });
  const tampered = structuredClone((await durable.read()).record);
  tampered.members[0].beforeRevision =
    tampered.members[1].beforeRevision;
  tampered.transactionId = transactionIdFor(tampered);
  await durable.write(tampered);

  const restarted = new CommunitySongFamilyImportCoordinator({
    rootPath: library.rootPath,
    songLibrary: library,
    recoveryAuthority
  });
  await assert.rejects(
    restarted.recover(),
    error => error.code === 'COMMUNITY_FAMILY_IMPORT_JOURNAL_INVALID'
  );
  const current = await library.withFamilyCommitSession(
    session => Promise.all([
      session.readCurrent('tampered-import-root'),
      session.readCurrent('tampered-import-ru')
    ]),
    { recoveryAuthority }
  );
  assert.deepEqual(
    current.map(document => document.revision),
    [root.revision, translation.revision]
  );
});

test('a local edit after Community reconciliation wins the original family-vector CAS', async t => {
  const {
    library,
    stateStore
  } = await workspace(t);
  const original = await library.saveSource(songSource({
    id: 'cas-family-root',
    title: 'CAS Family',
    line: 'Reconciled local original'
  }));
  const translation = await library.saveSource(songSource({
    id: 'cas-family-ru',
    title: 'CAS перевод',
    language: 'ru',
    translationOf: 'cas-family-root',
    line: 'Reconciled local translation'
  }), { expectedRevision: null });
  await stateStore.saveConnectionState(CONNECTION_ID, {
    cursor: 'cas-family-baseline',
    lastSyncAt: NOW,
    songs: {
      'cas-family-root': {
        syncId: 'cas-family-root',
        localFamilyId: 'cas-family-root',
        remoteTitle: 'CAS Family',
        alternateTitles: [],
        syncVersion: 1,
        remoteRevision: 'song:cas-family-root:1',
        documents: {
          'cas-family-root': {
            localRevision: original.revision,
            remoteRevision: original.revision
          },
          'cas-family-ru': {
            localRevision: translation.revision,
            remoteRevision: translation.revision
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
  const remoteDocuments = [
    songSource({
      id: 'cas-family-root',
      title: 'CAS Family',
      line: 'Remote original'
    }),
    songSource({
      id: 'cas-family-ru',
      title: 'CAS перевод',
      language: 'ru',
      translationOf: 'cas-family-root',
      line: 'Remote translation'
    })
  ].map(source => ({
    id: /id: ([^\n]+)/.exec(source)[1],
    source,
    revision: crypto.createHash('sha256').update(source).digest('hex'),
    song: parseSongDocument(source)
  }));
  let interleaved = false;
  const client = clientStub({
    async listSongChanges() {
      if (!interleaved) {
        interleaved = true;
        await library.saveSource(songSource({
          id: 'cas-family-ru',
          title: 'CAS перевод',
          language: 'ru',
          translationOf: 'cas-family-root',
          line: 'Concurrent operator edit'
        }), {
          expectedSongId: 'cas-family-ru',
          expectedRevision: translation.revision
        });
      }
      return {
        items: [remoteSong({
          syncId: 'cas-family-root',
          syncVersion: 2,
          syncDocuments: remoteDocuments.map(({
            id,
            source,
            revision
          }) => ({ id, source, revision })),
          title: 'CAS Family'
        })],
        nextCursor: 'cas-family-final',
        hasMore: false
      };
    }
  });

  const result = await synchronizer({
    client,
    library,
    stateStore
  }).sync();
  assert.equal(result.conflicts, 1);
  assert.equal(result.pulled, 0);
  assert.equal(
    (await library.read('cas-family-root')).revision,
    original.revision
  );
  assert.match(
    (await library.read('cas-family-ru')).source,
    /Concurrent operator edit/
  );
  assert.equal(
    (await stateStore.getSongState(
      CONNECTION_ID,
      'cas-family-root'
    )).conflict.code,
    'LOCAL_IMPORT_CONFLICT'
  );
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

test('physical loss of a tracked family pointer fails closed and never shrinks Community', async t => {
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

  await assert.rejects(
    sync.sync(),
    error => error.code === 'LIBRARY_POINTER_INVALID'
  );
  const state = await stateStore.getSongState(CONNECTION_ID, 'protected-family');
  assert.equal(state.conflict, null);
  assert.deepEqual(
    Object.keys(state.documents).sort(),
    ['protected-family', 'protected-family-ru']
  );
  assert.equal(updates.length, 0, 'generic sync must not publish a smaller family');
});

test('physical loss of every tracked family pointer fails closed without reimport', async t => {
  const { library, stateStore } = await workspace(t);
  const root = await library.saveSource(songSource({
    id: 'fully-missing-family',
    title: 'Fully Missing Family',
    line: 'Original'
  }));
  const translation = await library.saveSource(songSource({
    id: 'fully-missing-family-ru',
    title: 'Полностью отсутствующая семья',
    language: 'ru',
    translationOf: root.song.id,
    line: 'Перевод'
  }), { expectedRevision: null });
  let remote = null;
  let listCalls = 0;
  let updates = 0;
  const client = clientStub({
    listSongChanges: async () => ({
      items: listCalls++ === 0 || !remote ? [] : [remote],
      nextCursor: `fully-missing-${listCalls}`,
      hasMore: false
    }),
    createSong: async input => {
      remote = remoteSong({
        syncId: input.syncId,
        syncVersion: 1,
        syncDocuments: input.syncDocuments,
        title: root.song.title
      });
      return remote;
    },
    updateSong: async () => {
      updates += 1;
      throw new Error('a fully missing family must not be replaced automatically');
    }
  });
  const sync = synchronizer({ client, library, stateStore });
  await sync.sync();

  for (const id of [root.song.id, translation.song.id]) {
    await fs.unlink(path.join(
      library.rootPath,
      idStorageKey(id),
      'current.json'
    ));
  }

  await assert.rejects(
    sync.sync(),
    error => error.code === 'LIBRARY_POINTER_INVALID'
  );
  assert.equal(updates, 0);
  assert.deepEqual((await library.list()).items, []);
  const state = await stateStore.getSongState(
    CONNECTION_ID,
    root.song.id
  );
  assert.equal(state.conflict, null);
  assert.deepEqual(
    Object.keys(state.documents).sort(),
    [root.song.id, translation.song.id]
  );
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

test('a multi-page poll refuses to roll its final checkpoint back to the starting cursor', async t => {
  const { library, stateStore } = await workspace(t);
  await stateStore.saveConnectionState(CONNECTION_ID, {
    cursor: 'starting-cursor',
    songs: {}
  });
  const cursors = [];
  const client = clientStub({
    listSongChanges: async ({ cursor }) => {
      cursors.push(cursor);
      return cursor === 'starting-cursor'
        ? { items: [], nextCursor: 'intermediate-cursor', hasMore: true }
        : { items: [], nextCursor: 'starting-cursor', hasMore: false };
    }
  });

  await assert.rejects(
    synchronizer({ client, library, stateStore }).sync(),
    error => error.code === 'INVALID_REMOTE_CURSOR'
  );
  assert.deepEqual(cursors, ['starting-cursor', 'intermediate-cursor']);
  assert.equal(
    (await stateStore.getConnectionState(CONNECTION_ID)).cursor,
    'starting-cursor'
  );
});

test('an empty single-page poll may keep its existing durable cursor', async t => {
  const { library, stateStore } = await workspace(t);
  await stateStore.saveConnectionState(CONNECTION_ID, {
    cursor: 'steady-cursor',
    songs: {}
  });
  const client = clientStub({
    listSongChanges: async ({ cursor }) => ({
      items: [],
      nextCursor: cursor,
      hasMore: false
    })
  });

  const result = await synchronizer({ client, library, stateStore }).sync();

  assert.equal(result.status, 'synced');
  assert.equal(result.cursor, 'steady-cursor');
  assert.equal(
    (await stateStore.getConnectionState(CONNECTION_ID)).cursor,
    'steady-cursor'
  );
});

test('a non-empty single-page poll must advance beyond its starting cursor', async t => {
  const { library, stateStore } = await workspace(t);
  await stateStore.saveConnectionState(CONNECTION_ID, {
    cursor: 'unchanged-content-cursor',
    songs: {}
  });
  const client = clientStub({
    listSongChanges: async ({ cursor }) => ({
      items: [remoteSong({
        syncId: 'replayed-metadata',
        syncDocuments: [],
        title: 'Replayed metadata'
      })],
      nextCursor: cursor,
      hasMore: false
    })
  });

  await assert.rejects(
    synchronizer({ client, library, stateStore }).sync(),
    error => error.code === 'INVALID_REMOTE_CURSOR'
  );
  const state = await stateStore.getConnectionState(CONNECTION_ID);
  assert.equal(state.cursor, 'unchanged-content-cursor');
  assert.deepEqual(Object.keys(state.songs), []);
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
  assert.deepEqual(
    Object.keys((await stateStore.getConnectionState(CONNECTION_ID)).songs),
    []
  );
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

test('keep-local cannot replace a public Community family until the exact local revision is reviewed', async t => {
  const { library, stateStore } = await workspace(t);
  const local = await library.saveSource(songSource({
    id: 'public-conflict',
    title: 'Public Conflict',
    line: 'Local choice'
  }));
  const remoteSource = songSource({
    id: local.song.id,
    title: local.song.title,
    line: 'Remote choice'
  });
  const remoteDocument = {
    id: local.song.id,
    source: remoteSource,
    revision: crypto.createHash('sha256').update(remoteSource).digest('hex')
  };
  let remote = remoteSong({
    syncId: local.song.id,
    syncVersion: 1,
    syncDocuments: [remoteDocument],
    title: local.song.title,
    visibility: 'public'
  });
  const updates = [];
  const client = clientStub({
    listSongChanges: async () => ({
      items: [remote],
      nextCursor: 'public-conflict-cursor',
      hasMore: false
    }),
    getSong: async () => remote,
    updateSong: async input => {
      updates.push(input);
      remote = remoteSong({
        syncId: local.song.id,
        syncVersion: input.expectedSyncVersion + 1,
        syncDocuments: input.syncDocuments,
        title: local.song.title,
        visibility: input.visibility || 'private',
        publishAt: input.publishAt || null
      });
      return remote;
    }
  });
  const sync = synchronizer({ client, library, stateStore });
  await sync.sync();
  const conflict = await stateStore.getSongState(
    CONNECTION_ID,
    local.song.id
  );

  await assert.rejects(
    sync.resolveConflict(local.song.id, {
      strategy: 'keep-local',
      expectedSyncVersion: conflict.syncVersion,
      expectedLocalRevision: conflict.conflict.localRevision
    }),
    error => error.code === 'SONG_SHARING_REVIEW_REQUIRED'
  );
  assert.equal(updates.length, 0);
  assert.ok(
    (await stateStore.getSongState(CONNECTION_ID, local.song.id)).conflict,
    'the unresolved copies remain preserved'
  );

  await confirmMemberSharingReview(
    stateStore,
    library,
    local.song.id,
    [local.song.id]
  );
  const resolved = await sync.resolveConflict(local.song.id, {
    strategy: 'keep-local',
    expectedSyncVersion: conflict.syncVersion,
    expectedLocalRevision: conflict.conflict.localRevision
  });
  assert.equal(resolved.resolved, true);
  assert.equal(resolved.strategy, 'keep-local');
  assert.equal(updates.length, 1);
  assert.equal(updates[0].expectedSyncVersion, 1);
  assert.equal(updates[0].syncDocuments[0].revision, local.revision);
  assert.equal(updates[0].visibility, 'private');
  assert.equal(
    (await stateStore.getSongState(CONNECTION_ID, local.song.id)).conflict,
    null
  );
  assert.equal(
    (await stateStore.getSongState(CONNECTION_ID, local.song.id)).visibility,
    'public'
  );
});

test('keep-local stops after a demotion response that still reports member-visible access', async t => {
  const { library, stateStore } = await workspace(t);
  const local = await library.saveSource(songSource({
    id: 'keep-local-failed-demotion',
    title: 'Keep Local Failed Demotion',
    line: 'Local conflict choice'
  }));
  const remoteSource = songSource({
    id: local.song.id,
    title: local.song.title,
    line: 'Remote conflict choice'
  });
  const remoteDocuments = [{
    id: local.song.id,
    source: remoteSource,
    revision: crypto.createHash('sha256').update(remoteSource).digest('hex')
  }];
  let remote = remoteSong({
    syncId: local.song.id,
    syncVersion: 1,
    syncDocuments: remoteDocuments,
    title: local.song.title,
    visibility: 'public'
  });
  const updates = [];
  const client = clientStub({
    listSongChanges: async () => ({
      items: [remote],
      nextCursor: 'keep-local-failed-demotion-cursor',
      hasMore: false
    }),
    getSong: async () => remote,
    updateSong: async input => {
      updates.push(input);
      remote = remoteSong({
        syncId: local.song.id,
        syncVersion: input.expectedSyncVersion + 1,
        syncDocuments: remoteDocuments,
        title: local.song.title,
        visibility: 'public',
        publishAt: null
      });
      return remote;
    }
  });
  const sync = synchronizer({ client, library, stateStore });
  await sync.sync();
  await stateStore.setSongVisibility(CONNECTION_ID, local.song.id, {
    visibility: 'private',
    expectedSyncVersion: 1
  });
  await confirmMemberSharingReview(
    stateStore,
    library,
    local.song.id,
    [local.song.id]
  );
  const conflict = await stateStore.getSongState(CONNECTION_ID, local.song.id);

  try {
    await sync.resolveConflict(local.song.id, {
      strategy: 'keep-local',
      expectedSyncVersion: conflict.syncVersion,
      expectedLocalRevision: conflict.conflict.localRevision
    });
  } catch (_error) {
    // Returning an error is an acceptable fail-closed outcome.
  }

  assert.equal(updates.length, 1, 'no content write may follow an unconfirmed demotion');
  assert.equal(updates[0].visibility, 'private');
  assert.equal(updates[0].publishAt, null);
  assert.equal(Object.hasOwn(updates[0], 'syncDocuments'), false);
});

test('Community decides the sharing boundary after keep-local stages private content', async t => {
  const { library, stateStore } = await workspace(t);
  const local = await library.saveSource(songSource({
    id: 'keep-local-schedule-window',
    title: 'Keep Local Schedule Window',
    line: 'Local scheduled choice'
  }));
  const remoteSource = songSource({
    id: local.song.id,
    title: local.song.title,
    line: 'Remote scheduled choice'
  });
  const remoteDocument = {
    id: local.song.id,
    source: remoteSource,
    revision: crypto.createHash('sha256').update(remoteSource).digest('hex')
  };
  const remote = remoteSong({
    syncId: local.song.id,
    syncVersion: 2,
    syncDocuments: [remoteDocument],
    title: local.song.title,
    visibility: 'scheduled-public',
    publishAt: '2026-07-28T17:00:00.000Z'
  });
  let updates = 0;
  let sharingTransactions = 0;
  const client = clientStub({
    listSongChanges: async () => ({
      items: [remote],
      nextCursor: 'keep-local-schedule-window-cursor',
      hasMore: false
    }),
    getSong: async () => remote,
    updateSong: async input => {
      updates += 1;
      return remoteSong({
        syncId: input.syncId,
        syncVersion: input.expectedSyncVersion + 1,
        syncDocuments: input.syncDocuments,
        title: local.song.title,
        visibility: 'private',
        publishAt: null
      });
    },
    shareSongWithMembers: async input => {
      sharingTransactions += 1;
      assert.equal(input.visibility, 'scheduled-public');
      assert.equal(input.publishAt, '2026-07-28T17:00:00.000Z');
      assert.equal(input.review.validUntil, '2026-07-26');
      throw new CommunityClientError(
        'BAD_REQUEST',
        'Heritage Community rejected the schedule outside its confirmed review boundary.'
      );
    }
  });
  const sync = synchronizer({ client, library, stateStore });
  await sync.sync();
  await confirmMemberSharingReview(
    stateStore,
    library,
    local.song.id,
    [local.song.id],
    { validUntil: '2026-07-26' }
  );
  const conflict = await stateStore.getSongState(CONNECTION_ID, local.song.id);

  await assert.rejects(
    sync.resolveConflict(local.song.id, {
      strategy: 'keep-local',
      expectedSyncVersion: conflict.syncVersion,
      expectedLocalRevision: conflict.conflict.localRevision
    }),
    error => error.code === 'BAD_REQUEST'
  );
  assert.equal(updates, 1);
  assert.equal(sharingTransactions, 1);
  const staged = await stateStore.getSongState(CONNECTION_ID, local.song.id);
  assert.equal(staged.visibility, 'private');
  assert.equal(staged.publishAt, null);
  assert.equal(staged.conflict, null);
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
  const foreignSource = songSource({
    id: 'foreign-family',
    title: 'Foreign Family',
    line: 'Foreign content'
  });
  const foreignRemote = remoteSong({
    syncId: 'foreign-family',
    syncVersion: firstRemote.syncVersion,
    syncDocuments: [{
      id: 'foreign-family',
      source: foreignSource,
      revision: crypto.createHash('sha256').update(foreignSource).digest('hex')
    }],
    title: 'Foreign Family'
  });
  let pointRead = foreignRemote;
  const client = clientStub({
    listSongChanges: async () => ({
      items: [firstRemote],
      nextCursor: 'cursor-keep-remote',
      hasMore: false
    }),
    getSong: async () => pointRead,
    updateSong: async () => {
      throw new Error('keeping the readable Community copy must not require a remote write');
    }
  });
  const sync = synchronizer({ client, library, stateStore });
  await sync.sync();
  const conflict = await stateStore.getSongState(CONNECTION_ID, local.song.id);
  const localBeforeResolution = await library.read(local.song.id);

  await assert.rejects(
    sync.resolveConflict(local.song.id, {
      strategy: 'keep-remote',
      expectedSyncVersion: conflict.syncVersion,
      expectedLocalRevision: conflict.conflict.localRevision
    }),
    error => error.code === 'REMOTE_ID_MISMATCH'
  );
  assert.equal(
    (await library.read(local.song.id)).revision,
    localBeforeResolution.revision
  );
  assert.ok(
    (await stateStore.getSongState(CONNECTION_ID, local.song.id)).conflict
  );
  assert.equal(
    (await library.list()).items.some(item => item.id === 'foreign-family'),
    false
  );

  pointRead = {
    ...firstRemote,
    revision: 'song:amazing-grace:reused'
  };
  await assert.rejects(
    sync.resolveConflict(local.song.id, {
      strategy: 'keep-remote',
      expectedSyncVersion: conflict.syncVersion,
      expectedLocalRevision: conflict.conflict.localRevision
    }),
    error => error.code === 'REMOTE_VERSION_REUSE'
  );
  assert.equal(
    (await library.read(local.song.id)).revision,
    localBeforeResolution.revision
  );

  pointRead = firstRemote;
  const resolved = await sync.resolveConflict(local.song.id, {
    strategy: 'keep-remote',
    expectedSyncVersion: conflict.syncVersion,
    expectedLocalRevision: conflict.conflict.localRevision
  });

  assert.equal(resolved.strategy, 'keep-remote');
  assert.match((await library.read(local.song.id)).source, /Remote choice/);
  assert.equal((await stateStore.getSongState(CONNECTION_ID, local.song.id)).conflict, null);
});
