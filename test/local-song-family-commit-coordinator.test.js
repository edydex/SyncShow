'use strict';

const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const test = require('node:test');

const {
  LocalSongFamilyCommitCoordinator
} = require('../src/services/project/LocalSongFamilyCommitCoordinator');
const {
  LocalSongLibrary,
  SongLibraryError,
  idStorageKey
} = require('../src/services/project/LocalSongLibrary');
const {
  DurableFamilyJournal
} = require('../src/services/project/DurableFamilyJournal');
const {
  parseSongDocument,
  serializeSongDocument
} = require('../src/services/project/SongDocument');

async function tempDirectory(t) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'syncshow-song-family-commit-')
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return fs.realpath(directory);
}

function canonicalSong({
  id,
  title,
  language,
  translationOf = null,
  lines
}) {
  const metadata = [
    '---',
    `id: ${id}`,
    `title: ${JSON.stringify(title)}`,
    `language: ${language}`
  ];
  if (translationOf) metadata.push(`translationOf: ${translationOf}`);
  const source = `${metadata.join('\n')}\n---\n\n^p1\n${lines.join('\n')}\n`;
  const documentSource = serializeSongDocument(
    parseSongDocument(source, { fileName: `${id}.md` })
  );
  return {
    documentSource,
    revision: crypto.createHash('sha256').update(documentSource).digest('hex'),
    finalTextSha256: crypto.createHash('sha256')
      .update(JSON.stringify([lines]))
      .digest('hex')
  };
}

function reviewSnapshot() {
  const root = canonicalSong({
    id: 'captured-family',
    title: 'Captured Family',
    language: 'en',
    lines: ['Root line one', 'Root line two']
  });
  const translation = canonicalSong({
    id: 'captured-family-ru',
    title: 'Семья песни',
    language: 'ru',
    translationOf: 'captured-family',
    lines: ['Первая строка', 'Вторая строка']
  });
  return {
    reviewedAt: '2026-07-28T12:00:00.000Z',
    family: {
      rootSongId: 'captured-family',
      members: [
        {
          songId: 'captured-family',
          translationOf: null,
          action: 'create',
          expectedRevision: null,
          reviewedRevision: root.revision,
          finalTextSha256: root.finalTextSha256,
          documentSource: root.documentSource
        },
        {
          songId: 'captured-family-ru',
          translationOf: 'captured-family',
          action: 'create',
          expectedRevision: null,
          reviewedRevision: translation.revision,
          finalTextSha256: translation.finalTextSha256,
          documentSource: translation.documentSource
        }
      ]
    }
  };
}

class MemoryReviewStore {
  constructor(snapshotHash, snapshot, { failReceiptOnce = false } = {}) {
    this.snapshotHash = snapshotHash;
    this.snapshot = snapshot;
    this.failReceiptOnce = failReceiptOnce;
    this.receipts = [];
  }

  async readSnapshot(snapshotHash) {
    assert.equal(snapshotHash, this.snapshotHash);
    return { snapshotHash, snapshot: this.snapshot };
  }

  async prepareCommitReceiptStorage({ snapshotHash }) {
    assert.equal(snapshotHash, this.snapshotHash);
    return { snapshotHash, prepared: true };
  }

  async saveCommitReceipt(receipt) {
    if (this.failReceiptOnce) {
      this.failReceiptOnce = false;
      throw new Error('injected receipt failure');
    }
    const existing = this.receipts.find(candidate =>
      candidate.snapshotHash === receipt.snapshotHash);
    if (existing) {
      assert.deepEqual(existing, receipt);
      return { receipt: existing, unchanged: true };
    }
    this.receipts.push(structuredClone(receipt));
    return { receipt, unchanged: false };
  }

  async readReviewStatus({ snapshotHash }) {
    assert.equal(snapshotHash, this.snapshotHash);
    const receipt = this.receipts[0] || null;
    if (!receipt) {
      return {
        snapshotHash,
        reviewed: false,
        receipts: [],
        skippedCorruptReceipts: 0
      };
    }
    return {
      snapshotHash,
      reviewed: true,
      receipts: [{
        receiptHash: snapshotHashFor(receipt),
        rootSongId: this.snapshot.family.rootSongId,
        results: this.snapshot.family.members.map(member => ({
          songId: member.songId,
          resultingRevision: member.reviewedRevision
        })),
        ...receipt
      }],
      skippedCorruptReceipts: 0
    };
  }
}

function snapshotHashFor(snapshot) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(snapshot))
    .digest('hex');
}

function familySystem(rootPath) {
  const recoveryAuthority = Symbol('test-family-recovery');
  return {
    recoveryAuthority,
    library: new LocalSongLibrary({
      rootPath,
      familyRecoveryAuthority: recoveryAuthority
    })
  };
}

async function createPendingJournal({
  rootPath,
  library,
  recoveryAuthority,
  store,
  snapshotHash
}) {
  const interrupted = new LocalSongFamilyCommitCoordinator({
    rootPath,
    songLibrary: library,
    reviewStore: store,
    recoveryAuthority,
    clock: () => new Date('2026-07-28T13:00:00.000Z'),
    onPhase(phase) {
      if (phase === 'journal-written') {
        throw new Error('stop with durable journal');
      }
    }
  });
  await assert.rejects(
    interrupted.commit({ snapshotHash }),
    /stop with durable journal/
  );
  return new DurableFamilyJournal({ rootPath });
}

test('a reviewed family commits exact pointers and a receipt before clearing its journal', async t => {
  const rootPath = await tempDirectory(t);
  const { library, recoveryAuthority } = familySystem(rootPath);
  const snapshot = reviewSnapshot();
  const snapshotHash = snapshotHashFor(snapshot);
  const store = new MemoryReviewStore(snapshotHash, snapshot);
  const phases = [];
  const coordinator = new LocalSongFamilyCommitCoordinator({
    rootPath,
    songLibrary: library,
    reviewStore: store,
    recoveryAuthority,
    clock: () => new Date('2026-07-28T13:00:00.000Z'),
    onPhase: phase => phases.push(phase)
  });

  const committed = await coordinator.commit({ snapshotHash });
  assert.equal(committed.familyId, 'captured-family');
  assert.match(committed.familyRevision, /^[a-f0-9]{64}$/);
  assert.equal(store.receipts.length, 1);
  assert.equal(
    store.receipts[0].familyRevision,
    committed.familyRevision
  );
  assert.deepEqual(
    committed.members.map(member => member.songId),
    ['captured-family', 'captured-family-ru']
  );
  assert.ok(phases.indexOf('receipt-saved') < phases.indexOf('journal-cleared'));
  assert.equal(
    (await new DurableFamilyJournal({ rootPath }).read()).clear,
    true
  );
  assert.equal(
    (await library.read('captured-family-ru')).song.translationOf,
    'captured-family'
  );
});

test('a clock earlier than review time cannot create a journal or promote a pointer', async t => {
  const rootPath = await tempDirectory(t);
  const { library, recoveryAuthority } = familySystem(rootPath);
  const snapshot = reviewSnapshot();
  const snapshotHash = snapshotHashFor(snapshot);
  const store = new MemoryReviewStore(snapshotHash, snapshot);
  const coordinator = new LocalSongFamilyCommitCoordinator({
    rootPath,
    songLibrary: library,
    reviewStore: store,
    recoveryAuthority,
    clock: () => new Date('2026-07-28T11:59:59.000Z')
  });

  await assert.rejects(
    coordinator.commit({ snapshotHash }),
    error => error?.code === 'FAMILY_COMMIT_CLOCK_INVALID'
  );
  assert.equal(
    await library.withCurrentSnapshot(
      session => session.readCurrent('captured-family')
    ),
    null
  );
  assert.equal(
    (await new DurableFamilyJournal({ rootPath }).read()).clear,
    true
  );
  assert.equal(store.receipts.length, 0);
});

test('restart rolls forward a crash after one pointer and current reads fail closed meanwhile', async t => {
  const rootPath = await tempDirectory(t);
  const { library, recoveryAuthority } = familySystem(rootPath);
  const snapshot = reviewSnapshot();
  const snapshotHash = snapshotHashFor(snapshot);
  const store = new MemoryReviewStore(snapshotHash, snapshot);
  const interrupted = new LocalSongFamilyCommitCoordinator({
    rootPath,
    songLibrary: library,
    reviewStore: store,
    recoveryAuthority,
    onPhase(phase) {
      if (phase === 'member-1-promoted') {
        throw new Error('injected process interruption');
      }
    }
  });

  await assert.rejects(
    interrupted.commit({ snapshotHash }),
    /injected process interruption/
  );
  assert.equal(
    (await new DurableFamilyJournal({ rootPath }).read()).clear,
    false
  );
  await assert.rejects(
    library.read('captured-family'),
    error => error instanceof SongLibraryError
      && error.code === 'SONG_FAMILY_RECOVERY_REQUIRED'
  );

  const restartedSystem = familySystem(rootPath);
  const restarted = new LocalSongFamilyCommitCoordinator({
    rootPath,
    songLibrary: restartedSystem.library,
    reviewStore: store,
    recoveryAuthority: restartedSystem.recoveryAuthority
  });
  const recovered = await restarted.recover();
  assert.equal(recovered.recovered, true);
  assert.equal(store.receipts.length, 1);
  assert.equal(
    (await library.read('captured-family-ru')).revision,
    snapshot.family.members[1].reviewedRevision
  );
});

test('recovery rejects an already-promoted revision with a detached pointer time', async t => {
  const rootPath = await tempDirectory(t);
  const { library, recoveryAuthority } = familySystem(rootPath);
  const snapshot = reviewSnapshot();
  const snapshotHash = snapshotHashFor(snapshot);
  const store = new MemoryReviewStore(snapshotHash, snapshot);
  const interrupted = new LocalSongFamilyCommitCoordinator({
    rootPath,
    songLibrary: library,
    reviewStore: store,
    recoveryAuthority,
    clock: () => new Date('2026-07-28T13:00:00.000Z'),
    onPhase(phase) {
      if (phase === 'member-1-promoted') {
        throw new Error('stop after first pointer');
      }
    }
  });
  await assert.rejects(
    interrupted.commit({ snapshotHash }),
    /stop after first pointer/
  );
  const pointerPath = path.join(
    rootPath,
    idStorageKey('captured-family'),
    'current.json'
  );
  const pointer = JSON.parse(await fs.readFile(pointerPath, 'utf8'));
  pointer.updatedAt = '2026-07-28T13:00:01.000Z';
  await fs.writeFile(pointerPath, `${JSON.stringify(pointer, null, 2)}\n`);

  const restarted = new LocalSongFamilyCommitCoordinator({
    rootPath,
    songLibrary: library,
    reviewStore: store,
    recoveryAuthority
  });
  await assert.rejects(
    restarted.recover(),
    error => error?.code === 'FAMILY_COMMIT_CONFLICT'
  );
  assert.equal(
    (await new DurableFamilyJournal({ rootPath }).read()).clear,
    false
  );
  assert.equal(store.receipts.length, 0);
});

test('receipt failure retains the journal and recovery finishes the same exact review', async t => {
  const rootPath = await tempDirectory(t);
  const { library, recoveryAuthority } = familySystem(rootPath);
  const snapshot = reviewSnapshot();
  const snapshotHash = snapshotHashFor(snapshot);
  const store = new MemoryReviewStore(snapshotHash, snapshot, {
    failReceiptOnce: true
  });
  const coordinator = new LocalSongFamilyCommitCoordinator({
    rootPath,
    songLibrary: library,
    reviewStore: store,
    recoveryAuthority,
    clock: () => new Date('2026-07-28T13:00:00.000Z')
  });

  await assert.rejects(
    coordinator.commit({ snapshotHash }),
    /injected receipt failure/
  );
  assert.equal(
    (await new DurableFamilyJournal({ rootPath }).read()).clear,
    false
  );
  const recovered = await coordinator.recover();
  assert.equal(recovered.familyId, 'captured-family');
  assert.equal(store.receipts.length, 1);
  assert.deepEqual(
    store.receipts[0].results.map(result => result.resultingRevision),
    snapshot.family.members.map(member => member.reviewedRevision)
  );
});

test('retrying the same request recovers its pending journal instead of restaging stale state', async t => {
  const rootPath = await tempDirectory(t);
  const { library, recoveryAuthority } = familySystem(rootPath);
  const snapshot = reviewSnapshot();
  const snapshotHash = snapshotHashFor(snapshot);
  const store = new MemoryReviewStore(snapshotHash, snapshot);
  let interrupt = true;
  const coordinator = new LocalSongFamilyCommitCoordinator({
    rootPath,
    songLibrary: library,
    reviewStore: store,
    recoveryAuthority,
    onPhase(phase) {
      if (interrupt && phase === 'member-1-promoted') {
        interrupt = false;
        throw new Error('retry me');
      }
    }
  });
  await assert.rejects(coordinator.commit({ snapshotHash }), /retry me/);

  const retried = await coordinator.commit({ snapshotHash });
  assert.equal(retried.familyId, 'captured-family');
  assert.equal(store.receipts.length, 1);
});

test('retrying an already completed review is an exact no-op', async t => {
  const rootPath = await tempDirectory(t);
  const { library, recoveryAuthority } = familySystem(rootPath);
  const snapshot = reviewSnapshot();
  const snapshotHash = snapshotHashFor(snapshot);
  const store = new MemoryReviewStore(snapshotHash, snapshot);
  const coordinator = new LocalSongFamilyCommitCoordinator({
    rootPath,
    songLibrary: library,
    reviewStore: store,
    recoveryAuthority
  });
  const first = await coordinator.commit({ snapshotHash });
  const retry = await coordinator.commit({ snapshotHash });

  assert.equal(retry.unchanged, true);
  assert.equal(retry.familyRevision, first.familyRevision);
  assert.equal(store.receipts.length, 1);
});

test('recovery preserves and refuses an unexpected current pointer state', async t => {
  const rootPath = await tempDirectory(t);
  const { library, recoveryAuthority } = familySystem(rootPath);
  const snapshot = reviewSnapshot();
  const snapshotHash = snapshotHashFor(snapshot);
  const store = new MemoryReviewStore(snapshotHash, snapshot);
  const interrupted = new LocalSongFamilyCommitCoordinator({
    rootPath,
    songLibrary: library,
    reviewStore: store,
    recoveryAuthority,
    onPhase(phase) {
      if (phase === 'journal-written') throw new Error('stop before promotion');
    }
  });
  await assert.rejects(
    interrupted.commit({ snapshotHash }),
    /stop before promotion/
  );

  const alternate = canonicalSong({
    id: 'captured-family',
    title: 'Captured Family',
    language: 'en',
    lines: ['Unrelated concurrent text']
  });
  await library.withFamilyCommitSession(async session => {
    const staged = await session.stageSource(alternate.documentSource, {
      expectedSongId: 'captured-family'
    });
    await session.promoteRevision(
      staged.song.id,
      staged.revision,
      { expectedRevision: null }
    );
  }, { recoveryAuthority });

  const restarted = new LocalSongFamilyCommitCoordinator({
    rootPath,
    songLibrary: library,
    reviewStore: store,
    recoveryAuthority
  });
  await assert.rejects(
    restarted.recover(),
    error => error?.code === 'FAMILY_COMMIT_CONFLICT'
  );
  assert.equal(
    (await library.read('captured-family', {
      revision: alternate.revision
    })).revision,
    alternate.revision
  );
  assert.equal(
    (await new DurableFamilyJournal({ rootPath }).read()).clear,
    false
  );
  assert.equal(store.receipts.length, 0);
});

test('recovery rejects commit-time journal tampering before changing a pointer', async t => {
  const rootPath = await tempDirectory(t);
  const { library, recoveryAuthority } = familySystem(rootPath);
  const snapshot = reviewSnapshot();
  const snapshotHash = snapshotHashFor(snapshot);
  const store = new MemoryReviewStore(snapshotHash, snapshot);
  const durableJournal = await createPendingJournal({
    rootPath,
    library,
    recoveryAuthority,
    store,
    snapshotHash
  });
  const journal = structuredClone((await durableJournal.read()).record);
  journal.committedAt = '2026-07-28T13:00:01.000Z';
  journal.pointerUpdatedAt = journal.committedAt;
  await durableJournal.write(journal);

  const restarted = new LocalSongFamilyCommitCoordinator({
    rootPath,
    songLibrary: library,
    reviewStore: store,
    recoveryAuthority
  });
  await assert.rejects(
    restarted.recover(),
    error => error?.code === 'FAMILY_COMMIT_JOURNAL_INVALID'
  );
  const current = await library.withFamilyCommitSession(
    session => Promise.all([
      session.readCurrent('captured-family'),
      session.readCurrent('captured-family-ru')
    ]),
    { recoveryAuthority }
  );
  assert.deepEqual(current, [null, null]);
  assert.equal((await durableJournal.read()).clear, false);
});

test('recovery rejects a pointer timestamp detached from the commit time', async t => {
  const rootPath = await tempDirectory(t);
  const { library, recoveryAuthority } = familySystem(rootPath);
  const snapshot = reviewSnapshot();
  const snapshotHash = snapshotHashFor(snapshot);
  const store = new MemoryReviewStore(snapshotHash, snapshot);
  const durableJournal = await createPendingJournal({
    rootPath,
    library,
    recoveryAuthority,
    store,
    snapshotHash
  });
  const journal = structuredClone((await durableJournal.read()).record);
  journal.pointerUpdatedAt = '2026-07-28T13:00:01.000Z';
  await durableJournal.write(journal);

  const restarted = new LocalSongFamilyCommitCoordinator({
    rootPath,
    songLibrary: library,
    reviewStore: store,
    recoveryAuthority
  });
  await assert.rejects(
    restarted.recover(),
    error => error?.code === 'FAMILY_COMMIT_JOURNAL_INVALID'
  );
  const root = await library.withFamilyCommitSession(
    session => session.readCurrent('captured-family'),
    { recoveryAuthority }
  );
  assert.equal(root, null);
  assert.equal((await durableJournal.read()).clear, false);
});

test('corrupt receipt evidence fails closed before a reviewed family can be restaged', async t => {
  const rootPath = await tempDirectory(t);
  const { library, recoveryAuthority } = familySystem(rootPath);
  const snapshot = reviewSnapshot();
  const snapshotHash = snapshotHashFor(snapshot);
  const store = new MemoryReviewStore(snapshotHash, snapshot);
  store.readReviewStatus = async ({ snapshotHash: requestedHash }) => {
    assert.equal(requestedHash, snapshotHash);
    return {
      snapshotHash,
      reviewed: false,
      receipts: [],
      skippedCorruptReceipts: 1
    };
  };
  const coordinator = new LocalSongFamilyCommitCoordinator({
    rootPath,
    songLibrary: library,
    reviewStore: store,
    recoveryAuthority
  });

  await assert.rejects(
    coordinator.commit({ snapshotHash }),
    error => error?.code === 'FAMILY_COMMIT_EVIDENCE_CORRUPT'
  );
  assert.equal(
    (await new DurableFamilyJournal({ rootPath }).read()).clear,
    true
  );
  assert.equal(
    await library.withCurrentSnapshot(
      session => session.readCurrent('captured-family')
    ),
    null
  );
});

test('family recovery capabilities are not exposed on service objects', async t => {
  const rootPath = await tempDirectory(t);
  const { library, recoveryAuthority } = familySystem(rootPath);
  const snapshot = reviewSnapshot();
  const snapshotHash = snapshotHashFor(snapshot);
  const coordinator = new LocalSongFamilyCommitCoordinator({
    rootPath,
    songLibrary: library,
    reviewStore: new MemoryReviewStore(snapshotHash, snapshot),
    recoveryAuthority
  });

  assert.equal(library.familyRecoveryAuthority, undefined);
  assert.equal(library.recoveryAuthority, undefined);
  assert.equal(library._withExclusiveSession, undefined);
  assert.equal(library._familyCommitSession, undefined);
  assert.equal(library._saveSourceUnderLibraryLock, undefined);
  assert.equal(library._stageFamilyUnderLibraryLock, undefined);
  assert.equal(library._promoteRevisionUnderLibraryLock, undefined);
  assert.equal(coordinator.recoveryAuthority, undefined);
});
