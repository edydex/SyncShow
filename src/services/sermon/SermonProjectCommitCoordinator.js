'use strict';

const fs = require('fs/promises');
const path = require('path');

const {
  atomicWriteFile,
  ensurePrivateDirectory,
  fsyncDirectory,
  readFileNoFollow,
  withExclusiveFileLock
} = require('../project/StorageSafety');
const { semanticProjectHash } = require('../project/ServiceProjectStore');

const JOURNAL_SCHEMA_VERSION = 1;
const MAX_JOURNAL_BYTES = 128 * 1024;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const RESOURCE_ID_PATTERN = /^sha256:[a-f0-9]{64}$/;
const REVISION_PATTERN = /^[a-f0-9]{64}$/;

class SermonProjectCommitError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SermonProjectCommitError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new SermonProjectCommitError(code, message, details);
}

function exactText(value, label, pattern) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    fail('INVALID_TRANSACTION', `${label} is invalid.`);
  }
  return value;
}

function nullableRevision(value, label) {
  return value === null ? null : exactText(value, label, REVISION_PATTERN);
}

function normalizeJournal(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('TRANSACTION_JOURNAL_INVALID', 'The pending sermon transaction is invalid.');
  }
  if (raw.schemaVersion !== JOURNAL_SCHEMA_VERSION) {
    fail(
      'TRANSACTION_JOURNAL_INVALID',
      'The pending sermon transaction uses an unsupported schema.'
    );
  }
  const createdAt = raw.createdAt;
  if (
    typeof createdAt !== 'string'
    || createdAt.length > 40
    || Number.isNaN(Date.parse(createdAt))
  ) {
    fail('TRANSACTION_JOURNAL_INVALID', 'The pending sermon transaction time is invalid.');
  }
  return Object.freeze({
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    projectId: exactText(raw.projectId, 'Project ID', ID_PATTERN),
    expectedProjectRevisionId: exactText(
      raw.expectedProjectRevisionId,
      'Expected project revision',
      REVISION_PATTERN
    ),
    savedProjectRevisionId: raw.savedProjectRevisionId === null
      ? null
      : exactText(raw.savedProjectRevisionId, 'Saved project revision', REVISION_PATTERN),
    desiredProjectHash: raw.desiredProjectHash === undefined
      || raw.desiredProjectHash === null
      ? null
      : exactText(raw.desiredProjectHash, 'Desired project hash', REVISION_PATTERN),
    resourceId: exactText(raw.resourceId, 'Sermon resource ID', RESOURCE_ID_PATTERN),
    resourceOwnerId: exactText(raw.resourceOwnerId, 'Sermon resource owner', ID_PATTERN),
    sermonId: exactText(raw.sermonId, 'Sermon ID', ID_PATTERN),
    expectedSermonRevision: nullableRevision(
      raw.expectedSermonRevision,
      'Expected sermon revision'
    ),
    nextSermonRevision: exactText(
      raw.nextSermonRevision,
      'Next sermon revision',
      REVISION_PATTERN
    ),
    createdAt: new Date(createdAt).toISOString()
  });
}

function projectContainsCommit(project, journal) {
  const resource = project?.resources?.[journal.resourceId];
  const owner = project?.items?.[journal.resourceOwnerId];
  return Boolean(
    project?.id === journal.projectId
    && journal.desiredProjectHash
    && semanticProjectHash(project) === journal.desiredProjectHash
    && resource?.kind === 'sermon'
    && resource.sha256 === journal.nextSermonRevision
    && resource.document?.id === journal.sermonId
    && owner?.sermonResourceId === journal.resourceId
  );
}

class SermonProjectCommitCoordinator {
  constructor({
    rootPath,
    projectStore,
    sermonLibrary,
    clock = () => new Date()
  } = {}) {
    if (typeof rootPath !== 'string' || !path.isAbsolute(rootPath)) {
      throw new TypeError('SermonProjectCommitCoordinator requires an absolute rootPath');
    }
    if (
      !projectStore
      || typeof projectStore.read !== 'function'
      || typeof projectStore.save !== 'function'
    ) {
      throw new TypeError('SermonProjectCommitCoordinator requires a project store');
    }
    if (
      !sermonLibrary
      || typeof sermonLibrary.readCurrent !== 'function'
      || typeof sermonLibrary.readRevision !== 'function'
      || typeof sermonLibrary.stageDocument !== 'function'
      || typeof sermonLibrary.promoteRevision !== 'function'
    ) {
      throw new TypeError('SermonProjectCommitCoordinator requires a sermon library');
    }
    if (typeof clock !== 'function') {
      throw new TypeError('SermonProjectCommitCoordinator clock is invalid');
    }
    this.rootPath = path.resolve(rootPath);
    this.journalPath = path.join(this.rootPath, 'pending-sermon-project.json');
    this.lockPath = path.join(this.rootPath, '.sermon-project-transaction-lock');
    this.projectStore = projectStore;
    this.sermonLibrary = sermonLibrary;
    this.clock = clock;
    this.operationTail = Promise.resolve();
  }

  _withTransactionLock(operation) {
    const pending = this.operationTail.then(async () => {
      await ensurePrivateDirectory(this.rootPath);
      return withExclusiveFileLock(this.lockPath, operation);
    });
    this.operationTail = pending.then(
      () => undefined,
      () => undefined
    );
    return pending;
  }

  async _readJournal() {
    await ensurePrivateDirectory(this.rootPath);
    let buffer;
    try {
      ({ buffer } = await readFileNoFollow(this.journalPath, MAX_JOURNAL_BYTES));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      fail(
        'TRANSACTION_JOURNAL_INVALID',
        'The pending sermon transaction could not be read safely.',
        { cause: error.code || error.name || 'read-failed' }
      );
    }
    try {
      return normalizeJournal(JSON.parse(buffer.toString('utf8')));
    } catch (error) {
      if (error instanceof SermonProjectCommitError) throw error;
      fail(
        'TRANSACTION_JOURNAL_INVALID',
        'The pending sermon transaction is not valid JSON.'
      );
    }
  }

  async _writeJournal(raw) {
    const journal = normalizeJournal(raw);
    await atomicWriteFile(
      this.journalPath,
      `${JSON.stringify(journal, null, 2)}\n`,
      {
        maximumBytes: MAX_JOURNAL_BYTES,
        mode: 0o600,
        rootPath: this.rootPath
      }
    );
    return journal;
  }

  async _clearJournal() {
    try {
      await fs.unlink(this.journalPath);
      await fsyncDirectory(this.rootPath).catch(() => {});
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  async _readCurrentProject(projectId) {
    try {
      return await this.projectStore.read(projectId);
    } catch (error) {
      if (error.code === 'PROJECT_NOT_FOUND') return null;
      throw error;
    }
  }

  async _readCurrentSermon(sermonId) {
    try {
      return await this.sermonLibrary.readCurrent(sermonId);
    } catch (error) {
      if (error.code === 'SERMON_NOT_FOUND') return null;
      throw error;
    }
  }

  async _recoverUnderLock() {
    const journal = await this._readJournal();
    if (!journal) {
      return Object.freeze({
        recovered: false,
        projectCommitted: false,
        sermonCurrent: null,
        message: null
      });
    }

    const currentProject = await this._readCurrentProject(journal.projectId);
    const projectCommitted = projectContainsCommit(currentProject?.project, journal);
    const currentSermon = await this._readCurrentSermon(journal.sermonId);
    let sermonCurrent = currentSermon?.revision === journal.nextSermonRevision;
    let message = null;

    if (projectCommitted
      && !sermonCurrent
      && (currentSermon?.revision || null) === journal.expectedSermonRevision) {
      try {
        await this.sermonLibrary.promoteRevision(
          journal.sermonId,
          journal.nextSermonRevision,
          { expectedRevision: journal.expectedSermonRevision }
        );
        sermonCurrent = true;
        message = 'SyncShow completed a sermon-library pointer update that was interrupted after the service was saved.';
      } catch (error) {
        if (error.code !== 'SERMON_CONFLICT') throw error;
        message = 'The service kept its exact reviewed sermon revision, but the local sermon library has a newer current edit. SyncShow did not overwrite that edit.';
      }
    } else if (projectCommitted && !sermonCurrent) {
      message = 'The service kept its exact reviewed sermon revision, but the local sermon library has a newer current edit. SyncShow did not overwrite that edit.';
    } else if (!journal.desiredProjectHash) {
      message = sermonCurrent
        ? 'SyncShow cleared a legacy sermon transaction journal after preserving the current sermon revision.'
        : 'SyncShow left the sermon-library pointer unchanged because a legacy transaction journal could not prove the full intended service revision.';
    } else if (!projectCommitted) {
      message = 'SyncShow discarded an interrupted staged sermon edit because the service revision was not saved.';
    }

    await this._clearJournal();
    return Object.freeze({
      recovered: true,
      projectCommitted,
      sermonCurrent,
      project: currentProject,
      message
    });
  }

  async recover() {
    return this._withTransactionLock(() => this._recoverUnderLock());
  }

  async commit({
    project,
    expectedProjectRevisionId,
    sermonDocument,
    expectedSermonRevision,
    resourceId,
    resourceOwnerId,
    reason = 'sermon-project-commit'
  } = {}) {
    return this._withTransactionLock(async () => {
      await this._recoverUnderLock();
      const projectId = exactText(project?.id, 'Project ID', ID_PATTERN);
      const expectedProjectRevision = exactText(
        expectedProjectRevisionId,
        'Expected project revision',
        REVISION_PATTERN
      );
      const ownerId = exactText(resourceOwnerId, 'Sermon resource owner', ID_PATTERN);
      const exactResourceId = exactText(
        resourceId,
        'Sermon resource ID',
        RESOURCE_ID_PATTERN
      );
      const expectedSermon = nullableRevision(
        expectedSermonRevision,
        'Expected sermon revision'
      );

      const staged = await this.sermonLibrary.stageDocument(sermonDocument, {
        expectedSermonId: sermonDocument?.id,
        expectedRevision: expectedSermon
      });
      const journal = normalizeJournal({
        schemaVersion: JOURNAL_SCHEMA_VERSION,
        projectId,
        expectedProjectRevisionId: expectedProjectRevision,
        savedProjectRevisionId: null,
        desiredProjectHash: semanticProjectHash(project),
        resourceId: exactResourceId,
        resourceOwnerId: ownerId,
        sermonId: staged.sermon.id,
        expectedSermonRevision: expectedSermon,
        nextSermonRevision: staged.revision,
        createdAt: this.clock().toISOString()
      });
      if (!projectContainsCommit(project, journal)) {
        fail(
          'INVALID_TRANSACTION',
          'The service project does not pin the staged sermon revision at its resource owner.'
        );
      }
      await this._writeJournal(journal);

      let savedProject;
      let recovery = null;
      try {
        savedProject = await this.projectStore.save(project, {
          expectedRevisionId: expectedProjectRevision,
          reason
        });
      } catch (projectError) {
        const recovered = await this._recoverUnderLock();
        if (!recovered.projectCommitted) throw projectError;
        savedProject = recovered.project;
        recovery = recovered;
      }

      if (!savedProject?.project || !projectContainsCommit(savedProject.project, journal)) {
        fail(
          'PROJECT_COMMIT_MISMATCH',
          'The saved service does not contain the reviewed sermon revision.'
        );
      }
      await this._writeJournal({
        ...journal,
        savedProjectRevisionId: savedProject.revisionId
      });

      let promoted = null;
      try {
        const current = await this._readCurrentSermon(journal.sermonId);
        if (current?.revision === journal.nextSermonRevision) {
          promoted = current;
        } else if (
          (current?.revision || null) === journal.expectedSermonRevision
        ) {
          promoted = await this.sermonLibrary.promoteRevision(
            journal.sermonId,
            journal.nextSermonRevision,
            { expectedRevision: journal.expectedSermonRevision }
          );
        } else {
          recovery = Object.freeze({
            recovered: true,
            projectCommitted: true,
            sermonCurrent: false,
            message: 'The service saved its exact reviewed sermon revision, but another sermon edit became current first. SyncShow preserved that newer edit.'
          });
        }
      } catch (error) {
        if (error.code !== 'SERMON_CONFLICT') throw error;
        recovery = Object.freeze({
          recovered: true,
          projectCommitted: true,
          sermonCurrent: false,
          message: 'The service saved its exact reviewed sermon revision, but another sermon edit became current first. SyncShow preserved that newer edit.'
        });
      }

      await this._clearJournal();
      return Object.freeze({
        project: savedProject,
        sermon: staged,
        promoted,
        recovery
      });
    });
  }
}

module.exports = {
  JOURNAL_SCHEMA_VERSION,
  SermonProjectCommitCoordinator,
  SermonProjectCommitError,
  normalizeJournal,
  projectContainsCommit
};
