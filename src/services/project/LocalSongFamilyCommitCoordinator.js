'use strict';

const crypto = require('crypto');
const path = require('path');

const {
  ensurePrivateDirectory
} = require('./StorageSafety');
const { familySnapshotHash } = require('./LocalSongLibrary');
const {
  DurableFamilyJournal
} = require('./DurableFamilyJournal');
const {
  compareCanonicalText,
  songFamilyRevision
} = require('./SongFamilyRevision');

const SONG_FAMILY_COMMIT_JOURNAL_SCHEMA_VERSION = 1;
const SONG_FAMILY_COMMIT_JOURNAL_KIND =
  'syncshow-local-song-family-commit';
const MAX_SONG_FAMILY_COMMIT_JOURNAL_BYTES = 512 * 1024;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REVISION_PATTERN = /^[a-f0-9]{64}$/;
const ACTIONS = new Set(['create', 'update', 'reuse']);
const RECOVERY_AUTHORITIES = new WeakMap();
const DURABLE_JOURNALS = new WeakMap();
const COMMUNITY_FAMILY_IMPORT_JOURNAL_KIND =
  'syncshow-community-song-family-import';

class LocalSongFamilyCommitError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'LocalSongFamilyCommitError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function fail(code, message, details = {}) {
  throw new LocalSongFamilyCommitError(code, message, details);
}

function exactKeys(value, keys, label, code = 'INVALID_FAMILY_COMMIT') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(code, `${label} is invalid.`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    fail(code, `${label} contains unsupported fields.`);
  }
}

function exactText(value, label, pattern, code = 'INVALID_FAMILY_COMMIT') {
  if (typeof value !== 'string' || !pattern.test(value)) {
    fail(code, `${label} is invalid.`);
  }
  return value;
}

function nullableRevision(value, label, code = 'INVALID_FAMILY_COMMIT') {
  return value === null
    ? null
    : exactText(value, label, REVISION_PATTERN, code);
}

function timestamp(value, label, code = 'INVALID_FAMILY_COMMIT') {
  if (
    typeof value !== 'string'
    || value.length > 40
    || Number.isNaN(Date.parse(value))
  ) {
    fail(code, `${label} is invalid.`);
  }
  return new Date(value).toISOString();
}

function familyCommitTransactionId(value) {
  const expectedDocuments = value.expectedSnapshot.documents
    .map(document => ({
      songId: document.songId,
      revision: document.revision,
      translationOf: document.translationOf
    }))
    .sort((left, right) =>
      Number(Boolean(left.translationOf))
        - Number(Boolean(right.translationOf))
      || compareCanonicalText(left.songId, right.songId));
  const members = value.members
    .map(member => ({
      songId: member.songId,
      language: member.language,
      translationOf: member.translationOf,
      action: member.action,
      beforeRevision: member.beforeRevision,
      afterRevision: member.afterRevision,
      finalTextSha256: member.finalTextSha256
    }))
    .sort((left, right) =>
      Number(Boolean(left.translationOf))
        - Number(Boolean(right.translationOf))
      || compareCanonicalText(left.songId, right.songId));
  return crypto.createHash('sha256')
    .update(JSON.stringify({
      schemaVersion: SONG_FAMILY_COMMIT_JOURNAL_SCHEMA_VERSION,
      kind: SONG_FAMILY_COMMIT_JOURNAL_KIND,
      snapshotHash: value.snapshotHash,
      familyId: value.familyId,
      reviewedAt: value.reviewedAt,
      committedAt: value.committedAt,
      expectedSnapshot: {
        familyId: value.expectedSnapshot.familyId,
        snapshotHash: value.expectedSnapshot.snapshotHash,
        familyRevision: value.expectedSnapshot.familyRevision,
        documents: expectedDocuments
      },
      nextFamilyRevision: value.nextFamilyRevision,
      members
    }))
    .digest('hex');
}

function normalizeExpectedSnapshot(raw, familyId, code) {
  exactKeys(
    raw,
    ['familyId', 'snapshotHash', 'familyRevision', 'documents'],
    'Expected family snapshot',
    code
  );
  if (raw.familyId !== familyId || !Array.isArray(raw.documents)) {
    fail(code, 'Expected family snapshot is invalid.');
  }
  const seen = new Set();
  const documents = raw.documents.map(document => {
    exactKeys(
      document,
      ['songId', 'revision', 'translationOf'],
      'Expected family member',
      code
    );
    const songId = exactText(document.songId, 'Expected song ID', ID_PATTERN, code);
    if (
      seen.has(songId)
      || (document.translationOf !== null
        && document.translationOf !== familyId)
    ) {
      fail(code, 'Expected family members are invalid.');
    }
    seen.add(songId);
    return Object.freeze({
      songId,
      revision: exactText(
        document.revision,
        'Expected song revision',
        REVISION_PATTERN,
        code
      ),
      translationOf: document.translationOf
    });
  }).sort((left, right) =>
    Number(Boolean(left.translationOf))
      - Number(Boolean(right.translationOf))
    || compareCanonicalText(left.songId, right.songId));
  const familyRevision = raw.familyRevision === null
    ? null
    : exactText(
      raw.familyRevision,
      'Expected family revision',
      REVISION_PATTERN,
      code
    );
  const expectedFamilyRevision = documents.length === 0
    ? null
    : songFamilyRevision(documents.map(document => ({
      song: {
        id: document.songId,
        translationOf: document.translationOf
      },
      revision: document.revision
    })));
  if (
    familyRevision !== expectedFamilyRevision
    || raw.snapshotHash !== familySnapshotHash(familyId, documents)
  ) {
    fail(code, 'Expected family snapshot is inconsistent.');
  }
  return Object.freeze({
    familyId,
    snapshotHash: exactText(
      raw.snapshotHash,
      'Expected family snapshot hash',
      REVISION_PATTERN,
      code
    ),
    familyRevision,
    documents: Object.freeze(documents)
  });
}

function normalizeJournal(raw) {
  const code = 'FAMILY_COMMIT_JOURNAL_INVALID';
  exactKeys(raw, [
    'schemaVersion',
    'kind',
    'transactionId',
    'snapshotHash',
    'familyId',
    'reviewedAt',
    'committedAt',
    'pointerUpdatedAt',
    'expectedSnapshot',
    'nextFamilyRevision',
    'members'
  ], 'Pending song-family transaction', code);
  if (
    raw.schemaVersion !== SONG_FAMILY_COMMIT_JOURNAL_SCHEMA_VERSION
    || raw.kind !== SONG_FAMILY_COMMIT_JOURNAL_KIND
    || !Array.isArray(raw.members)
    || raw.members.length < 1
    || raw.members.length > 32
  ) {
    fail(code, 'Pending song-family transaction is invalid.');
  }
  const familyId = exactText(raw.familyId, 'Family ID', ID_PATTERN, code);
  const members = raw.members.map(member => {
    exactKeys(member, [
      'songId',
      'language',
      'translationOf',
      'action',
      'beforeRevision',
      'afterRevision',
      'finalTextSha256'
    ], 'Pending family member', code);
    const songId = exactText(member.songId, 'Song ID', ID_PATTERN, code);
    if (
      typeof member.language !== 'string'
      || !member.language
      || member.language.length > 35
      || !ACTIONS.has(member.action)
      || (member.translationOf !== null
        && member.translationOf !== familyId)
    ) {
      fail(code, 'Pending family member is invalid.');
    }
    return Object.freeze({
      songId,
      language: member.language,
      translationOf: member.translationOf,
      action: member.action,
      beforeRevision: nullableRevision(
        member.beforeRevision,
        'Previous song revision',
        code
      ),
      afterRevision: exactText(
        member.afterRevision,
        'Resulting song revision',
        REVISION_PATTERN,
        code
      ),
      finalTextSha256: exactText(
        member.finalTextSha256,
        'Final song text hash',
        REVISION_PATTERN,
        code
      )
    });
  }).sort((left, right) =>
    Number(Boolean(left.translationOf))
      - Number(Boolean(right.translationOf))
    || compareCanonicalText(left.songId, right.songId));
  if (
    new Set(members.map(member => member.songId)).size !== members.length
    || members.filter(member =>
      member.songId === familyId && member.translationOf === null).length !== 1
    || members.some(member =>
      member.songId !== familyId && member.translationOf !== familyId)
  ) {
    fail(code, 'Pending family membership is invalid.');
  }
  const expectedSnapshot = normalizeExpectedSnapshot(
    raw.expectedSnapshot,
    familyId,
    code
  );
  const nextFamilyRevision = exactText(
    raw.nextFamilyRevision,
    'Resulting family revision',
    REVISION_PATTERN,
    code
  );
  const exactNextRevision = songFamilyRevision(members.map(member => ({
    song: {
      id: member.songId,
      translationOf: member.translationOf
    },
    revision: member.afterRevision
  })));
  if (nextFamilyRevision !== exactNextRevision) {
    fail(code, 'Pending resulting family revision is inconsistent.');
  }
  const snapshotHash = exactText(
    raw.snapshotHash,
    'Family review snapshot hash',
    REVISION_PATTERN,
    code
  );
  const reviewedAt = timestamp(raw.reviewedAt, 'Family review time', code);
  const committedAt = timestamp(raw.committedAt, 'Family commit time', code);
  const pointerUpdatedAt = timestamp(
    raw.pointerUpdatedAt,
    'Family pointer update time',
    code
  );
  if (pointerUpdatedAt !== committedAt) {
    fail(code, 'Pending family pointer time is inconsistent.');
  }
  const normalized = {
    schemaVersion: SONG_FAMILY_COMMIT_JOURNAL_SCHEMA_VERSION,
    kind: SONG_FAMILY_COMMIT_JOURNAL_KIND,
    transactionId: raw.transactionId,
    snapshotHash,
    familyId,
    reviewedAt,
    committedAt,
    pointerUpdatedAt,
    expectedSnapshot,
    nextFamilyRevision,
    members: Object.freeze(members)
  };
  const transactionId = exactText(
    raw.transactionId,
    'Family transaction ID',
    REVISION_PATTERN,
    code
  );
  if (transactionId !== familyCommitTransactionId(normalized)) {
    fail(code, 'Pending family transaction integrity check failed.');
  }
  normalized.transactionId = transactionId;
  return Object.freeze(normalized);
}

function snapshotPayload(value) {
  return value?.snapshot || value;
}

function snapshotMembers(snapshot) {
  const family = snapshot?.family;
  if (
    !family
    || typeof family !== 'object'
    || Array.isArray(family)
    || typeof family.rootSongId !== 'string'
    || !Array.isArray(family.members)
  ) {
    fail('INVALID_FAMILY_REVIEW', 'The saved song-family review is invalid.');
  }
  return {
    familyId: family.rootSongId,
    members: family.members
  };
}

function expectedSnapshotFromReview(familyId, members) {
  const documents = members
    .filter(member => member.expectedRevision !== null)
    .map(member => ({
      songId: member.songId,
      revision: member.expectedRevision,
      translationOf: member.translationOf
    }))
    .sort((left, right) =>
      Number(Boolean(left.translationOf))
        - Number(Boolean(right.translationOf))
      || compareCanonicalText(left.songId, right.songId));
  return {
    familyId,
    snapshotHash: familySnapshotHash(familyId, documents),
    familyRevision: documents.length === 0
      ? null
      : songFamilyRevision(documents.map(document => ({
        song: {
          id: document.songId,
          translationOf: document.translationOf
        },
        revision: document.revision
      }))),
    documents
  };
}

class LocalSongFamilyCommitCoordinator {
  constructor({
    rootPath,
    songLibrary,
    reviewStore,
    recoveryAuthority,
    clock = () => new Date(),
    onPhase = null
  } = {}) {
    if (typeof rootPath !== 'string' || !path.isAbsolute(rootPath)) {
      throw new TypeError(
        'LocalSongFamilyCommitCoordinator requires an absolute rootPath'
      );
    }
    if (
      !songLibrary
      || typeof songLibrary.withFamilyCommitSession !== 'function'
      || path.resolve(songLibrary.rootPath || '') !== path.resolve(rootPath)
    ) {
      throw new TypeError(
        'LocalSongFamilyCommitCoordinator requires the song library at rootPath'
      );
    }
    if (
      !reviewStore
      || typeof reviewStore.readSnapshot !== 'function'
      || typeof reviewStore.prepareCommitReceiptStorage !== 'function'
      || typeof reviewStore.saveCommitReceipt !== 'function'
      || typeof reviewStore.readReviewStatus !== 'function'
    ) {
      throw new TypeError(
        'LocalSongFamilyCommitCoordinator requires a family review store'
      );
    }
    if (typeof recoveryAuthority !== 'symbol') {
      throw new TypeError(
        'LocalSongFamilyCommitCoordinator recoveryAuthority is invalid'
      );
    }
    if (typeof clock !== 'function') {
      throw new TypeError('LocalSongFamilyCommitCoordinator clock is invalid');
    }
    if (onPhase !== null && typeof onPhase !== 'function') {
      throw new TypeError(
        'LocalSongFamilyCommitCoordinator onPhase is invalid'
      );
    }
    this.rootPath = path.resolve(rootPath);
    this.songLibrary = songLibrary;
    this.reviewStore = reviewStore;
    RECOVERY_AUTHORITIES.set(this, recoveryAuthority);
    DURABLE_JOURNALS.set(this, new DurableFamilyJournal({
      rootPath: this.rootPath
    }));
    this.clock = clock;
    this.onPhase = onPhase;
  }

  async _phase(name, journal) {
    if (this.onPhase) await this.onPhase(name, journal);
  }

  async _readJournal() {
    let active;
    try {
      active = await DURABLE_JOURNALS.get(this).read();
    } catch (error) {
      fail(
        'FAMILY_COMMIT_JOURNAL_INVALID',
        'The pending song-family transaction could not be read safely.',
        { cause: error.code || error.name || 'read-failed' }
      );
    }
    if (active.clear) return null;
    if (active.record?.kind === COMMUNITY_FAMILY_IMPORT_JOURNAL_KIND) {
      return Object.freeze({ handledByCommunityCoordinator: true });
    }
    if (active.record?.kind !== SONG_FAMILY_COMMIT_JOURNAL_KIND) {
      fail(
        'FAMILY_COMMIT_JOURNAL_INVALID',
        'The pending song-family transaction has an unknown authority.'
      );
    }
    try {
      return normalizeJournal(active.record);
    } catch (error) {
      if (error instanceof LocalSongFamilyCommitError) throw error;
      fail(
        'FAMILY_COMMIT_JOURNAL_INVALID',
        'The pending song-family transaction is not valid JSON.'
      );
    }
  }

  async _writeJournal(raw) {
    const journal = normalizeJournal(raw);
    await DURABLE_JOURNALS.get(this).write(journal);
    return journal;
  }

  async _clearJournal() {
    await DURABLE_JOURNALS.get(this).clear();
  }

  async _receiptFor(journal) {
    return this.reviewStore.saveCommitReceipt({
      snapshotHash: journal.snapshotHash,
      committedAt: journal.committedAt,
      familyRevision: journal.nextFamilyRevision,
      results: journal.members.map(member => ({
        songId: member.songId,
        previousRevision: member.beforeRevision,
        resultingRevision: member.afterRevision
      }))
    });
  }

  async _completedCommitUnderSession(session, snapshotHash) {
    const status = await this.reviewStore.readReviewStatus({ snapshotHash });
    if (
      !status
      || !Array.isArray(status.receipts)
      || !Number.isSafeInteger(status.skippedCorruptReceipts)
      || status.skippedCorruptReceipts < 0
      || status.skippedCorruptReceipts > 0
      || status.receipts.length > 1
    ) {
      fail(
        'FAMILY_COMMIT_EVIDENCE_CORRUPT',
        'The reviewed family has inconsistent durable commit evidence.'
      );
    }
    if (!status.reviewed && status.receipts.length === 0) return null;
    if (!status.reviewed || status.receipts.length !== 1) {
      fail(
        'FAMILY_COMMIT_EVIDENCE_CORRUPT',
        'The reviewed family has inconsistent durable commit evidence.'
      );
    }
    const receipt = status.receipts[0];
    const final = await session.snapshotFamily(receipt.rootSongId);
    const revisionById = new Map(
      final.documents.map(document => [document.songId, document.revision])
    );
    if (
      final.familyRevision !== receipt.familyRevision
      || final.documents.length !== receipt.results.length
      || receipt.results.some(result =>
        revisionById.get(result.songId) !== result.resultingRevision)
    ) {
      fail(
        'FAMILY_COMMIT_ALREADY_CHANGED',
        'This review was committed previously, but the local song family has changed since then.'
      );
    }
    return Object.freeze({
      recovered: false,
      unchanged: true,
      familyId: receipt.rootSongId,
      familyRevision: receipt.familyRevision,
      members: receipt.results,
      receipt: Object.freeze({
        receiptHash: receipt.receiptHash,
        receipt
      })
    });
  }

  async _rollForwardUnderSession(session, journal) {
    const stored = snapshotPayload(
      await this.reviewStore.readSnapshot(journal.snapshotHash)
    );
    await this.reviewStore.prepareCommitReceiptStorage({
      snapshotHash: journal.snapshotHash
    });
    const review = snapshotMembers(stored);
    if (review.familyId !== journal.familyId) {
      fail(
        'FAMILY_COMMIT_REVIEW_MISMATCH',
        'The pending family transaction points to different review evidence.'
      );
    }
    const reviewedById = new Map(
      review.members.map(member => [member.songId, member])
    );
    const expectedFromReview = expectedSnapshotFromReview(
      review.familyId,
      review.members
    );
    if (
      stored.reviewedAt !== journal.reviewedAt
      || review.members.length !== journal.members.length
      || JSON.stringify(expectedFromReview) !==
        JSON.stringify(journal.expectedSnapshot)
    ) {
      fail(
        'FAMILY_COMMIT_REVIEW_MISMATCH',
        'The pending family transaction no longer matches its reviewed family state.'
      );
    }
    for (const member of journal.members) {
      const reviewed = reviewedById.get(member.songId);
      if (
        !reviewed
        || reviewed.reviewedRevision !== member.afterRevision
        || reviewed.expectedRevision !== member.beforeRevision
        || reviewed.action !== member.action
        || reviewed.finalTextSha256 !== member.finalTextSha256
      ) {
        fail(
          'FAMILY_COMMIT_REVIEW_MISMATCH',
          'The pending family transaction no longer matches its reviewed documents.'
        );
      }
      const staged = await session.readRevision(
        member.songId,
        member.afterRevision
      );
      if (
        staged.song.translationOf !== member.translationOf
        || staged.song.language !== member.language
      ) {
        fail(
          'FAMILY_COMMIT_REVISION_MISMATCH',
          'A staged family revision no longer matches the pending transaction.'
        );
      }
    }

    for (const [index, member] of journal.members.entries()) {
      const current = await session.readCurrent(member.songId);
      const currentRevision = current?.revision || null;
      if (currentRevision === member.afterRevision) {
        if (
          member.beforeRevision !== member.afterRevision
          && current.updatedAt !== journal.pointerUpdatedAt
        ) {
          fail(
            'FAMILY_COMMIT_CONFLICT',
            `Song ${member.songId} has the resulting revision with an unrelated pointer timestamp.`,
            { songId: member.songId }
          );
        }
        await this._phase(`member-${index + 1}-already-current`, journal);
        continue;
      }
      if (currentRevision !== member.beforeRevision) {
        fail(
          'FAMILY_COMMIT_CONFLICT',
          `Song ${member.songId} changed outside the reviewed family transaction.`,
          {
            songId: member.songId,
            expectedRevision: member.beforeRevision,
            resultingRevision: member.afterRevision,
            currentRevision
          }
        );
      }
      await session.promoteRevision(
        member.songId,
        member.afterRevision,
        {
          expectedRevision: member.beforeRevision,
          updatedAt: journal.pointerUpdatedAt
        }
      );
      await this._phase(`member-${index + 1}-promoted`, journal);
    }

    const final = await session.snapshotFamily(journal.familyId);
    const finalById = new Map(
      final.documents.map(document => [document.songId, document.revision])
    );
    if (
      final.familyRevision !== journal.nextFamilyRevision
      || final.documents.length !== journal.members.length
      || journal.members.some(member =>
        finalById.get(member.songId) !== member.afterRevision)
    ) {
      fail(
        'FAMILY_COMMIT_FINAL_MISMATCH',
        'The recovered local song family does not match the reviewed transaction.'
      );
    }
    const receipt = await this._receiptFor(journal);
    await this._phase('receipt-saved', journal);
    await this._clearJournal();
    await this._phase('journal-cleared', journal);
    return Object.freeze({
      recovered: true,
      familyId: journal.familyId,
      familyRevision: journal.nextFamilyRevision,
      members: journal.members,
      receipt
    });
  }

  async recover() {
    await ensurePrivateDirectory(this.rootPath);
    return this.songLibrary.withFamilyCommitSession(async session => {
      const journal = await this._readJournal();
      if (!journal || journal.handledByCommunityCoordinator) {
        return Object.freeze({
          handled: !journal,
          recovered: false,
          familyId: null,
          familyRevision: null,
          members: Object.freeze([]),
          receipt: null
        });
      }
      return this._rollForwardUnderSession(session, journal);
    }, { recoveryAuthority: RECOVERY_AUTHORITIES.get(this) });
  }

  async commit({ snapshotHash } = {}) {
    exactKeys(
      { snapshotHash },
      ['snapshotHash'],
      'Reviewed family commit request'
    );
    const exactSnapshotHash = exactText(
      snapshotHash,
      'Family review snapshot hash',
      REVISION_PATTERN
    );
    await ensurePrivateDirectory(this.rootPath);
    return this.songLibrary.withFamilyCommitSession(async session => {
      const pending = await this._readJournal();
      if (pending?.handledByCommunityCoordinator) {
        fail(
          'FAMILY_COMMIT_RECOVERY_REQUIRED',
          'Finish recovering the pending Community song-family import before committing a reviewed family.'
        );
      }
      if (pending) {
        const recovered = await this._rollForwardUnderSession(session, pending);
        if (pending.snapshotHash === exactSnapshotHash) return recovered;
      }
      const completed = await this._completedCommitUnderSession(
        session,
        exactSnapshotHash
      );
      if (completed) return completed;

      const stored = snapshotPayload(
        await this.reviewStore.readSnapshot(exactSnapshotHash)
      );
      const review = snapshotMembers(stored);
      const expectedSnapshot = expectedSnapshotFromReview(
        review.familyId,
        review.members
      );
      const staged = await session.stageFamily({
        familyId: review.familyId,
        expectedSnapshot,
        documents: review.members.map(member => ({
          expectedSongId: member.songId,
          documentSource: member.documentSource
        }))
      });
      const stagedById = new Map(
        staged.documents.map(document => [document.song.id, document])
      );
      for (const member of review.members) {
        if (
          stagedById.get(member.songId)?.revision !== member.reviewedRevision
        ) {
          fail(
            'FAMILY_COMMIT_REVIEW_MISMATCH',
            'A reviewed song document does not match its staged revision.'
          );
        }
      }
      const commitTime = this.clock();
      const committedAt = commitTime instanceof Date
        && !Number.isNaN(commitTime.getTime())
        ? commitTime.toISOString()
        : null;
      if (
        committedAt === null
        || Date.parse(committedAt) < Date.parse(stored.reviewedAt)
      ) {
        fail(
          'FAMILY_COMMIT_CLOCK_INVALID',
          'The local clock predates this reviewed family, so no song pointers were changed.'
        );
      }
      const reviewedById = new Map(
        review.members.map(member => [member.songId, member])
      );
      const journalPayload = {
        schemaVersion: SONG_FAMILY_COMMIT_JOURNAL_SCHEMA_VERSION,
        kind: SONG_FAMILY_COMMIT_JOURNAL_KIND,
        snapshotHash: exactSnapshotHash,
        familyId: staged.familyId,
        reviewedAt: stored.reviewedAt,
        committedAt,
        pointerUpdatedAt: committedAt,
        expectedSnapshot,
        nextFamilyRevision: staged.nextFamilyRevision,
        members: staged.members.map(member => ({
          ...member,
          action: reviewedById.get(member.songId).action,
          finalTextSha256: reviewedById.get(member.songId).finalTextSha256
        }))
      };
      await this.reviewStore.prepareCommitReceiptStorage({
        snapshotHash: exactSnapshotHash
      });
      const journal = await this._writeJournal({
        ...journalPayload,
        transactionId: familyCommitTransactionId(journalPayload)
      });
      await this._phase('journal-written', journal);
      return this._rollForwardUnderSession(session, journal);
    }, { recoveryAuthority: RECOVERY_AUTHORITIES.get(this) });
  }
}

module.exports = {
  LocalSongFamilyCommitCoordinator,
  LocalSongFamilyCommitError,
  MAX_SONG_FAMILY_COMMIT_JOURNAL_BYTES,
  SONG_FAMILY_COMMIT_JOURNAL_KIND,
  SONG_FAMILY_COMMIT_JOURNAL_SCHEMA_VERSION,
  normalizeJournal
};
