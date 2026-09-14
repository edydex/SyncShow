'use strict';

const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const { TextDecoder } = require('util');

const {
  atomicWriteFile,
  fsyncDirectory,
  readFileNoFollow,
  withExclusiveFileLock
} = require('../project/StorageSafety');

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION_MS = 90 * DAY_MS;
const MINIMUM_RETENTION_MS = 30 * DAY_MS;
const MAXIMUM_RETENTION_MS = 10 * 365 * DAY_MS;
const RETENTION_SCHEMA_VERSION = 1;
const RETENTION_STATE_KIND = 'syncshow-sermon-source-retention-state';
const RETENTION_PLAN_KIND = 'syncshow-sermon-source-retention-startup-plan';
const MAX_STATE_BYTES = 64 * 1024 * 1024;
const MAX_PLAN_BYTES = 16 * 1024;
const MAX_SCAN_FILES = 200_000;
const MAX_SCAN_BYTES = 1024 * 1024 * 1024 * 1024;
const MAX_SCAN_OBJECTS = 100_000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

class LocalSermonSourceRetentionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'LocalSermonSourceRetentionError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function fail(code, message, details = {}) {
  throw new LocalSermonSourceRetentionError(code, message, details);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
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

function canonicalBuffer(value) {
  return Buffer.from(`${canonicalJson(value)}\n`, 'utf8');
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function exactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  const expected = new Set(keys);
  return actual.length === expected.size && actual.every(key => expected.has(key));
}

function canonicalTimestamp(value) {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function scanCapacity(value, fallback, maximum, label) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${label} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

function requireMethod(value, method, label) {
  if (!value || typeof value[method] !== 'function') {
    throw new TypeError(`${label} must provide ${method}()`);
  }
}

class LocalSermonSourceRetention {
  constructor(options = {}) {
    requireMethod(options.sourceStore, 'collectVerifiedObjects', 'sourceStore');
    requireMethod(options.sourceStore, 'deleteVerifiedObject', 'sourceStore');
    requireMethod(options.sermonLibrary, 'collectSourceObjectReferences', 'sermonLibrary');
    requireMethod(options.projectStore, 'collectSermonSourceObjectReferences', 'projectStore');
    requireMethod(options.extractionStore, 'collectSourceObjectReferences', 'extractionStore');
    if (
      typeof options.sourceStore.rootPath !== 'string'
      || !path.isAbsolute(options.sourceStore.rootPath)
    ) {
      throw new TypeError('sourceStore must use an absolute rootPath');
    }
    const retentionMs = options.retentionMs === undefined
      ? DEFAULT_RETENTION_MS
      : options.retentionMs;
    if (
      !Number.isSafeInteger(retentionMs)
      || retentionMs < MINIMUM_RETENTION_MS
      || retentionMs > MAXIMUM_RETENTION_MS
    ) {
      throw new TypeError(
        `retentionMs must be between ${MINIMUM_RETENTION_MS} and ${MAXIMUM_RETENTION_MS}`
      );
    }
    if (options.transactionCoordinator !== undefined && options.transactionCoordinator !== null) {
      requireMethod(options.transactionCoordinator, 'recover', 'transactionCoordinator');
    }
    if (options.clock !== undefined && typeof options.clock !== 'function') {
      throw new TypeError('clock must be a function');
    }

    this.sourceStore = options.sourceStore;
    this.sermonLibrary = options.sermonLibrary;
    this.projectStore = options.projectStore;
    this.extractionStore = options.extractionStore;
    this.transactionCoordinator = options.transactionCoordinator || null;
    this._setRootPath(options.sourceStore.rootPath);
    this.clock = options.clock || (() => new Date());
    this.retentionMs = retentionMs;
    this.maximumReferenceFiles = scanCapacity(
      options.maximumReferenceFiles,
      MAX_SCAN_FILES,
      MAX_SCAN_FILES,
      'maximumReferenceFiles'
    );
    this.maximumReferenceBytes = scanCapacity(
      options.maximumReferenceBytes,
      MAX_SCAN_BYTES,
      MAX_SCAN_BYTES,
      'maximumReferenceBytes'
    );
    this.maximumObjects = scanCapacity(
      options.maximumObjects,
      MAX_SCAN_OBJECTS,
      MAX_SCAN_OBJECTS,
      'maximumObjects'
    );
    this.maximumObjectBytes = scanCapacity(
      options.maximumObjectBytes,
      MAX_SCAN_BYTES,
      MAX_SCAN_BYTES,
      'maximumObjectBytes'
    );
  }

  _setRootPath(rootPath) {
    this.rootPath = path.resolve(rootPath);
    this.statePath = path.join(this.rootPath, '.source-retention-state.json');
    this.planPath = path.join(this.rootPath, '.source-retention-startup-plan.json');
    this.lockPath = path.join(this.rootPath, '.source-retention-lock');
  }

  _now() {
    const value = this.clock();
    const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
    if (!Number.isFinite(date.getTime())) {
      fail('CLOCK_INVALID', 'The retention clock did not provide a valid time.');
    }
    return date;
  }

  _normalizeState(raw) {
    if (
      !exactKeys(raw, ['schemaVersion', 'kind', 'updatedAt', 'objects'])
      || raw.schemaVersion !== RETENTION_SCHEMA_VERSION
      || raw.kind !== RETENTION_STATE_KIND
      || !canonicalTimestamp(raw.updatedAt)
      || !raw.objects
      || typeof raw.objects !== 'object'
      || Array.isArray(raw.objects)
    ) {
      fail('RETENTION_STATE_CORRUPT', 'The sermon source retention ledger failed validation.');
    }
    const objects = {};
    const entries = Object.entries(raw.objects);
    if (entries.length > this.maximumObjects) {
      fail('RETENTION_STATE_CORRUPT', 'The sermon source retention ledger exceeds its bound.');
    }
    for (const [digest, record] of entries) {
      if (
        !SHA256_PATTERN.test(digest)
        || !exactKeys(record, ['firstSeenUnreferencedAt', 'sizeBytes'])
        || !canonicalTimestamp(record.firstSeenUnreferencedAt)
        || !Number.isSafeInteger(record.sizeBytes)
        || record.sizeBytes < 1
      ) {
        fail('RETENTION_STATE_CORRUPT', 'The sermon source retention ledger failed validation.');
      }
      objects[digest] = {
        firstSeenUnreferencedAt: record.firstSeenUnreferencedAt,
        sizeBytes: record.sizeBytes
      };
    }
    return {
      schemaVersion: RETENTION_SCHEMA_VERSION,
      kind: RETENTION_STATE_KIND,
      updatedAt: raw.updatedAt,
      objects
    };
  }

  _normalizePlan(raw) {
    if (
      !exactKeys(raw, [
        'schemaVersion',
        'kind',
        'candidateHash',
        'candidateCount',
        'candidateBytes',
        'retentionMs',
        'auditedAt',
        'confirmedAt'
      ])
      || raw.schemaVersion !== RETENTION_SCHEMA_VERSION
      || raw.kind !== RETENTION_PLAN_KIND
      || !SHA256_PATTERN.test(raw.candidateHash || '')
      || !Number.isSafeInteger(raw.candidateCount)
      || raw.candidateCount < 1
      || !Number.isSafeInteger(raw.candidateBytes)
      || raw.candidateBytes < 1
      || raw.retentionMs !== this.retentionMs
      || !canonicalTimestamp(raw.auditedAt)
      || !canonicalTimestamp(raw.confirmedAt)
    ) {
      fail('RETENTION_PLAN_CORRUPT', 'The confirmed sermon source cleanup plan failed validation.');
    }
    return {
      schemaVersion: RETENTION_SCHEMA_VERSION,
      kind: RETENTION_PLAN_KIND,
      candidateHash: raw.candidateHash,
      candidateCount: raw.candidateCount,
      candidateBytes: raw.candidateBytes,
      retentionMs: raw.retentionMs,
      auditedAt: raw.auditedAt,
      confirmedAt: raw.confirmedAt
    };
  }

  async _readCanonicalRecord(filePath, maximumBytes, normalize, missingIsNull) {
    let buffer;
    let stats;
    try {
      ({ buffer, stats } = await readFileNoFollow(filePath, maximumBytes));
    } catch (error) {
      if (missingIsNull && error.code === 'ENOENT') return null;
      throw error;
    }
    if (process.platform !== 'win32' && (stats.mode & 0o077) !== 0) {
      fail('RETENTION_EVIDENCE_UNSAFE', 'Sermon source retention evidence is not owner-only.');
    }
    let parsed;
    try {
      parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer));
    } catch (_error) {
      fail('RETENTION_EVIDENCE_CORRUPT', 'Sermon source retention evidence is unreadable.');
    }
    const normalized = normalize.call(this, parsed);
    if (!buffer.equals(canonicalBuffer(normalized))) {
      fail('RETENTION_EVIDENCE_CORRUPT', 'Sermon source retention evidence is not canonical.');
    }
    return normalized;
  }

  async _readState(now) {
    const state = await this._readCanonicalRecord(
      this.statePath,
      MAX_STATE_BYTES,
      this._normalizeState,
      true
    );
    return state || {
      schemaVersion: RETENTION_SCHEMA_VERSION,
      kind: RETENTION_STATE_KIND,
      updatedAt: now.toISOString(),
      objects: {}
    };
  }

  async _writeState(state) {
    await atomicWriteFile(this.statePath, canonicalBuffer(state), {
      rootPath: this.rootPath,
      maximumBytes: MAX_STATE_BYTES,
      mode: 0o600
    });
  }

  async _readPlan() {
    return this._readCanonicalRecord(
      this.planPath,
      MAX_PLAN_BYTES,
      this._normalizePlan,
      true
    );
  }

  async _writePlan(plan) {
    await atomicWriteFile(this.planPath, canonicalBuffer(plan), {
      rootPath: this.rootPath,
      maximumBytes: MAX_PLAN_BYTES,
      mode: 0o600
    });
  }

  async _clearPlan() {
    try {
      const stats = await fs.lstat(this.planPath);
      if (!stats.isFile() || stats.isSymbolicLink()) {
        fail('RETENTION_PLAN_CORRUPT', 'The confirmed sermon source cleanup plan is unsafe.');
      }
      await fs.unlink(this.planPath);
      await fsyncDirectory(this.rootPath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  async _recoverTransactions() {
    if (this.transactionCoordinator) await this.transactionCoordinator.recover();
  }

  async _auditUnderLock() {
    await this._recoverTransactions();
    const now = this._now();
    const state = await this._readState(now);
    const referenceOptions = {
      maximumFiles: this.maximumReferenceFiles,
      maximumBytes: this.maximumReferenceBytes
    };
    const libraryReferences = await this.sermonLibrary.collectSourceObjectReferences(
      referenceOptions
    );
    const projectReferences = await this.projectStore.collectSermonSourceObjectReferences(
      referenceOptions
    );
    const extractionReferences = await this.extractionStore.collectSourceObjectReferences(
      referenceOptions
    );
    const inventory = await this.sourceStore.collectVerifiedObjects({
      maximumObjects: this.maximumObjects,
      maximumBytes: this.maximumObjectBytes
    });
    const referencedDigests = new Set([
      ...libraryReferences.digests,
      ...projectReferences.digests,
      ...extractionReferences.digests
    ]);
    const objectDigests = new Set(inventory.objects.map(object => object.sha256));
    const missingReferencedDigests = [...referencedDigests]
      .filter(digest => !objectDigests.has(digest));
    if (missingReferencedDigests.length > 0) {
      fail(
        'REFERENCED_OBJECT_MISSING',
        'Cleanup stopped because canonical records reference an unavailable sermon source object.',
        { missingObjectCount: missingReferencedDigests.length }
      );
    }
    const nextObjects = {};
    const candidates = [];
    let referencedObjectCount = 0;
    let referencedBytes = 0;
    let unreferencedObjectCount = 0;
    let unreferencedBytes = 0;
    let waitingObjectCount = 0;
    let waitingBytes = 0;
    let eligibleBytes = 0;

    for (const object of inventory.objects) {
      if (referencedDigests.has(object.sha256)) {
        referencedObjectCount += 1;
        referencedBytes += object.sizeBytes;
        continue;
      }
      unreferencedObjectCount += 1;
      unreferencedBytes += object.sizeBytes;
      const previous = state.objects[object.sha256];
      const firstSeen = previous
        && previous.sizeBytes === object.sizeBytes
        && Date.parse(previous.firstSeenUnreferencedAt) <= now.getTime()
        ? previous.firstSeenUnreferencedAt
        : now.toISOString();
      nextObjects[object.sha256] = {
        firstSeenUnreferencedAt: firstSeen,
        sizeBytes: object.sizeBytes
      };
      if (now.getTime() - Date.parse(firstSeen) >= this.retentionMs) {
        candidates.push({
          objectId: object.objectId,
          sha256: object.sha256,
          sizeBytes: object.sizeBytes,
          firstSeenUnreferencedAt: firstSeen
        });
        eligibleBytes += object.sizeBytes;
      } else {
        waitingObjectCount += 1;
        waitingBytes += object.sizeBytes;
      }
    }
    candidates.sort((left, right) => left.sha256.localeCompare(right.sha256));
    const nextState = {
      schemaVersion: RETENTION_SCHEMA_VERSION,
      kind: RETENTION_STATE_KIND,
      updatedAt: now.toISOString(),
      objects: Object.fromEntries(
        Object.entries(nextObjects).sort(([left], [right]) => left.localeCompare(right))
      )
    };
    await this._writeState(nextState);
    const candidateHash = sha256(canonicalBuffer({
      schemaVersion: RETENTION_SCHEMA_VERSION,
      retentionMs: this.retentionMs,
      candidates: candidates.map(candidate => ({
        objectId: candidate.objectId,
        sizeBytes: candidate.sizeBytes,
        firstSeenUnreferencedAt: candidate.firstSeenUnreferencedAt
      }))
    }));
    const summary = deepFreeze({
      schemaVersion: RETENTION_SCHEMA_VERSION,
      auditedAt: now.toISOString(),
      retentionDays: this.retentionMs / DAY_MS,
      objectCount: inventory.objectCount,
      objectBytes: inventory.totalBytes,
      referencedObjectCount,
      referencedBytes,
      missingReferencedObjectCount: 0,
      unreferencedObjectCount,
      unreferencedBytes,
      waitingObjectCount,
      waitingBytes,
      eligibleObjectCount: candidates.length,
      eligibleBytes,
      candidateHash
    });
    return { summary, candidates, state: nextState };
  }

  async _withRetentionLock(operation, errorCode) {
    try {
      await this.sourceStore.initialize();
      this._setRootPath(this.sourceStore.rootPath);
      return await withExclusiveFileLock(this.lockPath, operation);
    } catch (error) {
      if (error instanceof LocalSermonSourceRetentionError) throw error;
      if (error.code === 'WRITE_LOCKED') {
        fail('RETENTION_BUSY', 'Sermon source retention is already being audited.');
      }
      fail(errorCode, 'Sermon source cleanup stopped before an unsafe change could be made.', {
        causeCode: typeof error.code === 'string' ? error.code : 'UNKNOWN'
      });
    }
  }

  async audit() {
    return this._withRetentionLock(
      async () => (await this._auditUnderLock()).summary,
      'RETENTION_AUDIT_ABORTED'
    );
  }

  async persistRestartPlan(raw = {}) {
    const candidateHash = typeof raw === 'string' ? raw : raw?.candidateHash;
    if (!SHA256_PATTERN.test(candidateHash || '')) {
      fail('INVALID_CANDIDATE_HASH', 'Confirm cleanup with the exact audited candidate hash.');
    }
    return this._withRetentionLock(async () => {
      const audit = await this._auditUnderLock();
      if (audit.summary.candidateHash !== candidateHash) {
        fail('CANDIDATE_SET_CHANGED', 'The cleanup candidates changed and must be reviewed again.');
      }
      if (audit.candidates.length < 1) {
        fail('NO_CLEANUP_CANDIDATES', 'There are no aged sermon source objects to clean up.');
      }
      const confirmedAt = this._now().toISOString();
      const plan = {
        schemaVersion: RETENTION_SCHEMA_VERSION,
        kind: RETENTION_PLAN_KIND,
        candidateHash,
        candidateCount: audit.candidates.length,
        candidateBytes: audit.summary.eligibleBytes,
        retentionMs: this.retentionMs,
        auditedAt: audit.summary.auditedAt,
        confirmedAt
      };
      await this._writePlan(plan);
      return deepFreeze({
        scheduled: true,
        requiresRestart: true,
        candidateHash,
        eligibleObjectCount: plan.candidateCount,
        eligibleBytes: plan.candidateBytes,
        confirmedAt
      });
    }, 'RETENTION_PLAN_ABORTED');
  }

  async confirmStartupPlan(raw = {}) {
    return this.persistRestartPlan(raw);
  }

  async applyConfirmedStartupPlan() {
    return this._withRetentionLock(async () => {
      const plan = await this._readPlan();
      if (!plan) {
        return deepFreeze({
          applied: false,
          skippedReason: 'no-confirmed-plan',
          deletedObjectCount: 0,
          deletedBytes: 0
        });
      }
      const audit = await this._auditUnderLock();
      if (
        audit.summary.candidateHash !== plan.candidateHash
        || audit.candidates.length !== plan.candidateCount
        || audit.summary.eligibleBytes !== plan.candidateBytes
      ) {
        await this._clearPlan();
        return deepFreeze({
          applied: false,
          skippedReason: 'plan-stale',
          deletedObjectCount: 0,
          deletedBytes: 0,
          currentCandidateHash: audit.summary.candidateHash
        });
      }

      let deletedObjectCount = 0;
      let deletedBytes = 0;
      for (const candidate of audit.candidates) {
        await this.sourceStore.deleteVerifiedObject(candidate.objectId, {
          sizeBytes: candidate.sizeBytes
        });
        deletedObjectCount += 1;
        deletedBytes += candidate.sizeBytes;
      }
      const completedAt = this._now().toISOString();
      const deletedDigests = new Set(audit.candidates.map(candidate => candidate.sha256));
      const completedState = {
        ...audit.state,
        updatedAt: completedAt,
        objects: Object.fromEntries(
          Object.entries(audit.state.objects)
            .filter(([digest]) => !deletedDigests.has(digest))
        )
      };
      await this._writeState(completedState);
      await this._clearPlan();
      return deepFreeze({
        applied: true,
        skippedReason: null,
        candidateHash: plan.candidateHash,
        deletedObjectCount,
        deletedBytes,
        completedAt
      });
    }, 'RETENTION_APPLY_ABORTED');
  }
}

module.exports = {
  DAY_MS,
  DEFAULT_RETENTION_MS,
  LocalSermonSourceRetention,
  LocalSermonSourceRetentionError,
  MINIMUM_RETENTION_MS,
  RETENTION_PLAN_KIND,
  RETENTION_SCHEMA_VERSION,
  RETENTION_STATE_KIND
};
