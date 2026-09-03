'use strict';

const crypto = require('crypto');
const path = require('path');

const { familySnapshotHash } = require('../project/LocalSongLibrary');
const {
  SONG_FAMILY_COMMIT_JOURNAL_KIND
} = require('../project/LocalSongFamilyCommitCoordinator');
const {
  compareCanonicalText,
  songFamilyRevision
} = require('../project/SongFamilyRevision');
const {
  ensurePrivateDirectory
} = require('../project/StorageSafety');
const {
  DurableFamilyJournal
} = require('../project/DurableFamilyJournal');

const COMMUNITY_FAMILY_IMPORT_JOURNAL_SCHEMA_VERSION = 1;
const COMMUNITY_FAMILY_IMPORT_JOURNAL_KIND =
  'syncshow-community-song-family-import';
const MAX_COMMUNITY_FAMILY_IMPORT_JOURNAL_BYTES = 512 * 1024;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REVISION_PATTERN = /^[a-f0-9]{64}$/;
const MAX_FAMILY_MEMBERS = 32;
const RECOVERY_AUTHORITIES = new WeakMap();
const DURABLE_JOURNALS = new WeakMap();

class CommunitySongFamilyImportError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CommunitySongFamilyImportError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function fail(code, message, details = {}) {
  throw new CommunitySongFamilyImportError(code, message, details);
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('COMMUNITY_FAMILY_IMPORT_JOURNAL_INVALID', `${label} is invalid.`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    fail(
      'COMMUNITY_FAMILY_IMPORT_JOURNAL_INVALID',
      `${label} contains unsupported fields.`
    );
  }
}

function exactText(value, label, pattern) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    fail(
      'COMMUNITY_FAMILY_IMPORT_JOURNAL_INVALID',
      `${label} is invalid.`
    );
  }
  return value;
}

function nullableRevision(value, label) {
  return value === null
    ? null
    : exactText(value, label, REVISION_PATTERN);
}

function exactTimestamp(value, label) {
  if (
    typeof value !== 'string'
    || value.length > 40
    || Number.isNaN(Date.parse(value))
  ) {
    fail(
      'COMMUNITY_FAMILY_IMPORT_JOURNAL_INVALID',
      `${label} is invalid.`
    );
  }
  return new Date(value).toISOString();
}

function normalizeExpectedSnapshot(raw, familyId) {
  exactKeys(
    raw,
    ['familyId', 'snapshotHash', 'familyRevision', 'documents'],
    'Expected Community family snapshot'
  );
  if (raw.familyId !== familyId || !Array.isArray(raw.documents)) {
    fail(
      'COMMUNITY_FAMILY_IMPORT_JOURNAL_INVALID',
      'Expected Community family snapshot is invalid.'
    );
  }
  const seen = new Set();
  const documents = raw.documents.map(document => {
    exactKeys(
      document,
      ['songId', 'revision', 'translationOf'],
      'Expected Community family member'
    );
    const songId = exactText(document.songId, 'Expected song ID', ID_PATTERN);
    if (
      seen.has(songId)
      || (
        document.translationOf !== null
        && document.translationOf !== familyId
      )
    ) {
      fail(
        'COMMUNITY_FAMILY_IMPORT_JOURNAL_INVALID',
        'Expected Community family members are invalid.'
      );
    }
    seen.add(songId);
    return Object.freeze({
      songId,
      revision: exactText(
        document.revision,
        'Expected song revision',
        REVISION_PATTERN
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
      REVISION_PATTERN
    );
  const calculatedFamilyRevision = documents.length === 0
    ? null
    : songFamilyRevision(documents.map(document => ({
      song: {
        id: document.songId,
        translationOf: document.translationOf
      },
      revision: document.revision
    })));
  if (
    familyRevision !== calculatedFamilyRevision
    || raw.snapshotHash !== familySnapshotHash(familyId, documents)
  ) {
    fail(
      'COMMUNITY_FAMILY_IMPORT_JOURNAL_INVALID',
      'Expected Community family snapshot is inconsistent.'
    );
  }
  return Object.freeze({
    familyId,
    snapshotHash: exactText(
      raw.snapshotHash,
      'Expected family snapshot hash',
      REVISION_PATTERN
    ),
    familyRevision,
    documents: Object.freeze(documents)
  });
}

function transactionIdFor(journal) {
  const expectedDocuments = journal.expectedSnapshot.documents
    .map(document => ({
      songId: document.songId,
      revision: document.revision,
      translationOf: document.translationOf
    }))
    .sort((left, right) =>
      Number(Boolean(left.translationOf))
        - Number(Boolean(right.translationOf))
      || compareCanonicalText(left.songId, right.songId));
  const members = journal.members
    .map(member => ({
      songId: member.songId,
      language: member.language,
      translationOf: member.translationOf,
      beforeRevision: member.beforeRevision,
      afterRevision: member.afterRevision
    }))
    .sort((left, right) =>
      Number(Boolean(left.translationOf))
        - Number(Boolean(right.translationOf))
      || compareCanonicalText(left.songId, right.songId));
  return crypto.createHash('sha256')
    .update(JSON.stringify({
      schemaVersion: COMMUNITY_FAMILY_IMPORT_JOURNAL_SCHEMA_VERSION,
      kind: COMMUNITY_FAMILY_IMPORT_JOURNAL_KIND,
      familyId: journal.familyId,
      committedAt: journal.committedAt,
      expectedSnapshot: {
        familyId: journal.expectedSnapshot.familyId,
        snapshotHash: journal.expectedSnapshot.snapshotHash,
        familyRevision: journal.expectedSnapshot.familyRevision,
        documents: expectedDocuments
      },
      nextFamilyRevision: journal.nextFamilyRevision,
      members
    }))
    .digest('hex');
}

function normalizeJournal(raw) {
  exactKeys(raw, [
    'schemaVersion',
    'kind',
    'transactionId',
    'familyId',
    'committedAt',
    'pointerUpdatedAt',
    'expectedSnapshot',
    'nextFamilyRevision',
    'members'
  ], 'Pending Community song-family import');
  if (
    raw.schemaVersion !== COMMUNITY_FAMILY_IMPORT_JOURNAL_SCHEMA_VERSION
    || raw.kind !== COMMUNITY_FAMILY_IMPORT_JOURNAL_KIND
    || !Array.isArray(raw.members)
    || raw.members.length < 1
    || raw.members.length > MAX_FAMILY_MEMBERS
  ) {
    fail(
      'COMMUNITY_FAMILY_IMPORT_JOURNAL_INVALID',
      'Pending Community song-family import is invalid.'
    );
  }
  const familyId = exactText(raw.familyId, 'Family ID', ID_PATTERN);
  const members = raw.members.map(member => {
    exactKeys(member, [
      'songId',
      'language',
      'translationOf',
      'beforeRevision',
      'afterRevision'
    ], 'Pending Community family member');
    const songId = exactText(member.songId, 'Song ID', ID_PATTERN);
    if (
      typeof member.language !== 'string'
      || member.language.length < 1
      || member.language.length > 35
      || (
        member.translationOf !== null
        && member.translationOf !== familyId
      )
    ) {
      fail(
        'COMMUNITY_FAMILY_IMPORT_JOURNAL_INVALID',
        'Pending Community family member is invalid.'
      );
    }
    return Object.freeze({
      songId,
      language: member.language,
      translationOf: member.translationOf,
      beforeRevision: nullableRevision(
        member.beforeRevision,
        'Previous song revision'
      ),
      afterRevision: exactText(
        member.afterRevision,
        'Resulting song revision',
        REVISION_PATTERN
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
    fail(
      'COMMUNITY_FAMILY_IMPORT_JOURNAL_INVALID',
      'Pending Community family membership is invalid.'
    );
  }
  const expectedSnapshot = normalizeExpectedSnapshot(
    raw.expectedSnapshot,
    familyId
  );
  const expectedById = new Map(
    expectedSnapshot.documents.map(document => [
      document.songId,
      document
    ])
  );
  if (
    expectedSnapshot.documents.length > members.length
    || expectedSnapshot.documents.some(document =>
      !members.some(member => member.songId === document.songId))
    || members.some(member => {
      const expected = expectedById.get(member.songId);
      return expected
        ? member.beforeRevision !== expected.revision
          || member.translationOf !== expected.translationOf
        : member.beforeRevision !== null;
    })
  ) {
    fail(
      'COMMUNITY_FAMILY_IMPORT_JOURNAL_INVALID',
      'Pending Community family members do not match the exact pre-import snapshot.'
    );
  }
  const nextFamilyRevision = exactText(
    raw.nextFamilyRevision,
    'Resulting family revision',
    REVISION_PATTERN
  );
  const calculatedFamilyRevision = songFamilyRevision(
    members.map(member => ({
      song: {
        id: member.songId,
        translationOf: member.translationOf
      },
      revision: member.afterRevision
    }))
  );
  const committedAt = exactTimestamp(raw.committedAt, 'Import commit time');
  const pointerUpdatedAt = exactTimestamp(
    raw.pointerUpdatedAt,
    'Family pointer update time'
  );
  const normalized = {
    schemaVersion: COMMUNITY_FAMILY_IMPORT_JOURNAL_SCHEMA_VERSION,
    kind: COMMUNITY_FAMILY_IMPORT_JOURNAL_KIND,
    transactionId: exactText(
      raw.transactionId,
      'Community family transaction ID',
      REVISION_PATTERN
    ),
    familyId,
    committedAt,
    pointerUpdatedAt,
    expectedSnapshot,
    nextFamilyRevision,
    members: Object.freeze(members)
  };
  if (
    nextFamilyRevision !== calculatedFamilyRevision
    || pointerUpdatedAt !== committedAt
    || normalized.transactionId !== transactionIdFor(normalized)
  ) {
    fail(
      'COMMUNITY_FAMILY_IMPORT_JOURNAL_INVALID',
      'Pending Community song-family import has inconsistent durable evidence.'
    );
  }
  return Object.freeze(normalized);
}

function normalizeRequest({ familyId, expectedSnapshot, documents } = {}) {
  if (typeof familyId !== 'string' || !ID_PATTERN.test(familyId)) {
    fail('INVALID_COMMUNITY_FAMILY_IMPORT', 'Community family ID is invalid.');
  }
  if (
    !Array.isArray(documents)
    || documents.length < 1
    || documents.length > MAX_FAMILY_MEMBERS
  ) {
    fail(
      'INVALID_COMMUNITY_FAMILY_IMPORT',
      'Community family import documents are invalid.'
    );
  }
  const seen = new Set();
  const normalizedDocuments = documents.map(document => {
    if (
      !document
      || typeof document !== 'object'
      || Array.isArray(document)
      || Object.keys(document).sort().join(',') !==
        'documentSource,expectedSongId'
      || typeof document.expectedSongId !== 'string'
      || !ID_PATTERN.test(document.expectedSongId)
      || typeof document.documentSource !== 'string'
      || seen.has(document.expectedSongId)
    ) {
      fail(
        'INVALID_COMMUNITY_FAMILY_IMPORT',
        'Community family import documents are invalid.'
      );
    }
    seen.add(document.expectedSongId);
    return Object.freeze({
      expectedSongId: document.expectedSongId,
      documentSource: document.documentSource
    });
  });
  return Object.freeze({
    familyId,
    expectedSnapshot: normalizeExpectedSnapshot(expectedSnapshot, familyId),
    documents: Object.freeze(normalizedDocuments)
  });
}

class CommunitySongFamilyImportCoordinator {
  constructor({
    rootPath,
    songLibrary,
    recoveryAuthority,
    clock = () => new Date(),
    onPhase = null
  } = {}) {
    if (typeof rootPath !== 'string' || !path.isAbsolute(rootPath)) {
      throw new TypeError(
        'CommunitySongFamilyImportCoordinator requires an absolute rootPath'
      );
    }
    if (
      !songLibrary
      || typeof songLibrary.withFamilyCommitSession !== 'function'
      || path.resolve(songLibrary.rootPath || '') !== path.resolve(rootPath)
    ) {
      throw new TypeError(
        'CommunitySongFamilyImportCoordinator requires the song library at rootPath'
      );
    }
    if (typeof recoveryAuthority !== 'symbol') {
      throw new TypeError(
        'CommunitySongFamilyImportCoordinator recoveryAuthority is invalid'
      );
    }
    if (typeof clock !== 'function') {
      throw new TypeError(
        'CommunitySongFamilyImportCoordinator clock is invalid'
      );
    }
    if (onPhase !== null && typeof onPhase !== 'function') {
      throw new TypeError(
        'CommunitySongFamilyImportCoordinator onPhase is invalid'
      );
    }
    this.rootPath = path.resolve(rootPath);
    this.songLibrary = songLibrary;
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
        'COMMUNITY_FAMILY_IMPORT_JOURNAL_INVALID',
        'The pending Community song-family import could not be read safely.',
        { cause: error.code || error.name || 'read-failed' }
      );
    }
    if (active.clear) return null;
    const raw = active.record;
    if (raw?.kind === SONG_FAMILY_COMMIT_JOURNAL_KIND) {
      return Object.freeze({ handledByReviewedCoordinator: true });
    }
    if (raw?.kind !== COMMUNITY_FAMILY_IMPORT_JOURNAL_KIND) {
      fail(
        'COMMUNITY_FAMILY_IMPORT_JOURNAL_INVALID',
        'The pending song-family transaction has an unknown authority.'
      );
    }
    return normalizeJournal(raw);
  }

  async _writeJournal(raw) {
    const journal = normalizeJournal(raw);
    await DURABLE_JOURNALS.get(this).write(journal);
    return journal;
  }

  async _clearJournal() {
    await DURABLE_JOURNALS.get(this).clear();
  }

  async _rollForwardUnderSession(session, journal) {
    for (const member of journal.members) {
      const staged = await session.readRevision(
        member.songId,
        member.afterRevision
      );
      if (
        staged.song.language !== member.language
        || staged.song.translationOf !== member.translationOf
      ) {
        fail(
          'COMMUNITY_FAMILY_IMPORT_RECOVERY_REQUIRED',
          'A staged Community song revision no longer matches its pending family import.',
          { songId: member.songId }
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
            'COMMUNITY_FAMILY_IMPORT_RECOVERY_REQUIRED',
            `Song ${member.songId} has the resulting revision with an unrelated pointer timestamp.`,
            { songId: member.songId }
          );
        }
        await this._phase(`member-${index + 1}-already-current`, journal);
        continue;
      }
      if (currentRevision !== member.beforeRevision) {
        fail(
          'COMMUNITY_FAMILY_IMPORT_RECOVERY_REQUIRED',
          `Song ${member.songId} changed outside the pending Community import.`,
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
        'COMMUNITY_FAMILY_IMPORT_RECOVERY_REQUIRED',
        'The recovered local family does not match its pending Community import.'
      );
    }
    await this._phase('family-verified', journal);
    await this._clearJournal();
    await this._phase('journal-cleared', journal);
    return Object.freeze({
      handled: true,
      recovered: true,
      familyId: journal.familyId,
      familyRevision: journal.nextFamilyRevision,
      members: journal.members
    });
  }

  async recover() {
    await ensurePrivateDirectory(this.rootPath);
    return this.songLibrary.withFamilyCommitSession(async session => {
      const journal = await this._readJournal();
      if (!journal || journal.handledByReviewedCoordinator) {
        return Object.freeze({
          handled: false,
          recovered: false,
          familyId: null,
          familyRevision: null,
          members: Object.freeze([])
        });
      }
      return this._rollForwardUnderSession(session, journal);
    }, { recoveryAuthority: RECOVERY_AUTHORITIES.get(this) });
  }

  async apply(request = {}) {
    const normalizedRequest = normalizeRequest(request);
    await ensurePrivateDirectory(this.rootPath);
    return this.songLibrary.withFamilyCommitSession(async session => {
      const pending = await this._readJournal();
      if (pending?.handledByReviewedCoordinator) {
        fail(
          'COMMUNITY_FAMILY_IMPORT_RECOVERY_REQUIRED',
          'Finish recovering the reviewed local song-family transaction before importing Community songs.'
        );
      }
      if (pending) await this._rollForwardUnderSession(session, pending);

      const currentSources = [];
      for (const document of normalizedRequest.expectedSnapshot.documents) {
        const current = await session.readRevision(
          document.songId,
          document.revision
        );
        currentSources.push({
          expectedSongId: document.songId,
          documentSource: current.source
        });
      }
      const finalById = new Map(
        currentSources.map(document => [document.expectedSongId, document])
      );
      for (const document of normalizedRequest.documents) {
        finalById.set(document.expectedSongId, document);
      }
      const staged = await session.stageFamily({
        familyId: normalizedRequest.familyId,
        expectedSnapshot: normalizedRequest.expectedSnapshot,
        documents: [...finalById.values()]
      });
      const unchanged = staged.members.every(member =>
        member.beforeRevision === member.afterRevision);
      if (unchanged) {
        return Object.freeze({
          handled: true,
          recovered: false,
          unchanged: true,
          familyId: staged.familyId,
          familyRevision: staged.nextFamilyRevision,
          members: staged.members,
          documents: staged.documents
        });
      }

      const committedAt = this.clock().toISOString();
      const journalInput = {
        schemaVersion: COMMUNITY_FAMILY_IMPORT_JOURNAL_SCHEMA_VERSION,
        kind: COMMUNITY_FAMILY_IMPORT_JOURNAL_KIND,
        transactionId: null,
        familyId: staged.familyId,
        committedAt,
        pointerUpdatedAt: committedAt,
        expectedSnapshot: staged.expectedSnapshot,
        nextFamilyRevision: staged.nextFamilyRevision,
        members: staged.members
      };
      journalInput.transactionId = transactionIdFor(journalInput);
      const journal = await this._writeJournal(journalInput);
      await this._phase('journal-written', journal);
      let result;
      try {
        result = await this._rollForwardUnderSession(session, journal);
      } catch (error) {
        if (error instanceof CommunitySongFamilyImportError) throw error;
        fail(
          'COMMUNITY_FAMILY_IMPORT_RECOVERY_REQUIRED',
          'The Community family import was interrupted and must be recovered before current songs are used.',
          { cause: error.code || error.name || 'interrupted' }
        );
      }
      return Object.freeze({
        ...result,
        unchanged: false,
        documents: staged.documents
      });
    }, { recoveryAuthority: RECOVERY_AUTHORITIES.get(this) });
  }
}

module.exports = {
  COMMUNITY_FAMILY_IMPORT_JOURNAL_KIND,
  COMMUNITY_FAMILY_IMPORT_JOURNAL_SCHEMA_VERSION,
  CommunitySongFamilyImportCoordinator,
  CommunitySongFamilyImportError,
  MAX_COMMUNITY_FAMILY_IMPORT_JOURNAL_BYTES,
  normalizeJournal,
  transactionIdFor
};
