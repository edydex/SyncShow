'use strict';

const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

const { isValidIsoDate } = require('../service-set/ServiceDate');
const {
  atomicWriteFile,
  ensurePrivateDirectory,
  fsyncDirectory,
  readFileNoFollow,
  withExclusiveFileLock
} = require('./StorageSafety');

const CURRENT_SHOW_PACKAGE_POINTER_SCHEMA_VERSION = 1;
const CURRENT_SHOW_PACKAGE_POINTER_KIND = 'syncshow-current-show-package';
const CURRENT_SHOW_PACKAGE_POINTER_FILE = 'current.json';
const MAX_CURRENT_SHOW_PACKAGE_POINTER_BYTES = 16 * 1024;
const SHOW_PACKAGE_ID_PATTERN = /^show-[a-f0-9]{64}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ACTIVATION_ID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const POISON_IDS = new Set(['__proto__', 'prototype', 'constructor']);
const ACTIVATION_KEYS = Object.freeze([
  'packageId',
  'packageManifestSha256',
  'projectId',
  'projectRevisionId',
  'projectRevision',
  'serviceDate',
  'venueProfileId',
  'venueProfileRevisionId'
]);
const POINTER_KEYS = Object.freeze([
  'schemaVersion',
  'kind',
  ...ACTIVATION_KEYS,
  'activationId',
  'activatedAt'
]);
const ACTIVATION_RECEIPT_KEYS = Object.freeze([
  'pointer',
  'previousPointer'
]);

class CurrentShowPackageError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CurrentShowPackageError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new CurrentShowPackageError(code, message, details);
}

function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireExactDataProperties(value, keys, field, code) {
  if (!isPlainRecord(value)) {
    fail(code, `${field} must be a plain object.`, { field });
  }
  const actualKeys = Reflect.ownKeys(value);
  const expectedKeys = [...keys].sort();
  if (actualKeys.some(key => typeof key !== 'string')
    || actualKeys.length !== expectedKeys.length
    || actualKeys.map(String).sort().some((key, index) => key !== expectedKeys[index])) {
    fail(code, `${field} must contain exactly the supported fields.`, {
      field,
      expected: expectedKeys,
      actual: actualKeys.map(String).sort()
    });
  }
  for (const key of actualKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
      fail(code, `${field}.${key} must be an own data property.`, { field, key });
    }
  }
}

function requireSafeId(value, field, code) {
  if (typeof value !== 'string'
    || !SAFE_ID_PATTERN.test(value)
    || POISON_IDS.has(value)) {
    fail(code, `${field} is invalid.`, { field });
  }
  return value;
}

function requirePackageId(value, field, code) {
  if (typeof value !== 'string' || !SHOW_PACKAGE_ID_PATTERN.test(value)) {
    fail(code, `${field} must be an exact Show package id.`, { field });
  }
  return value;
}

function requireRevisionId(value, field, code) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    fail(code, `${field} must be a lowercase SHA-256 digest.`, { field });
  }
  return value;
}

function requireActivationId(value, field, code) {
  if (typeof value !== 'string' || !ACTIVATION_ID_PATTERN.test(value)) {
    fail(code, `${field} must be a canonical random activation id.`, { field });
  }
  return value;
}

function requireProjectRevision(value, field, code) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(code, `${field} must be a non-negative safe integer.`, { field });
  }
  return value;
}

function requireServiceDate(value, field, code) {
  if (!isValidIsoDate(value)) {
    fail(code, `${field} must be a real ISO service date.`, { field });
  }
  return value;
}

function requireTimestamp(value, field, code) {
  if (typeof value !== 'string' || value.length > 40) {
    fail(code, `${field} must be a canonical ISO timestamp.`, { field });
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    fail(code, `${field} must be a canonical ISO timestamp.`, { field });
  }
  return value;
}

function normalizeActivation(raw) {
  const code = 'INVALID_CURRENT_SHOW_PACKAGE_ACTIVATION';
  requireExactDataProperties(raw, ACTIVATION_KEYS, 'Current package activation', code);
  return Object.freeze({
    packageId: requirePackageId(raw.packageId, 'packageId', code),
    packageManifestSha256: requireRevisionId(
      raw.packageManifestSha256,
      'packageManifestSha256',
      code
    ),
    projectId: requireSafeId(raw.projectId, 'projectId', code),
    projectRevisionId: requireRevisionId(
      raw.projectRevisionId,
      'projectRevisionId',
      code
    ),
    projectRevision: requireProjectRevision(
      raw.projectRevision,
      'projectRevision',
      code
    ),
    serviceDate: requireServiceDate(raw.serviceDate, 'serviceDate', code),
    venueProfileId: requireSafeId(raw.venueProfileId, 'venueProfileId', code),
    venueProfileRevisionId: requireRevisionId(
      raw.venueProfileRevisionId,
      'venueProfileRevisionId',
      code
    )
  });
}

function normalizeCurrentShowPackagePointer(raw) {
  const code = 'CURRENT_SHOW_PACKAGE_POINTER_INVALID';
  requireExactDataProperties(raw, POINTER_KEYS, 'Current package pointer', code);
  if (raw.schemaVersion !== CURRENT_SHOW_PACKAGE_POINTER_SCHEMA_VERSION
    || raw.kind !== CURRENT_SHOW_PACKAGE_POINTER_KIND) {
    fail(
      code,
      `Current package pointer must be a ${CURRENT_SHOW_PACKAGE_POINTER_KIND} schema v${CURRENT_SHOW_PACKAGE_POINTER_SCHEMA_VERSION} document.`
    );
  }
  return Object.freeze({
    schemaVersion: CURRENT_SHOW_PACKAGE_POINTER_SCHEMA_VERSION,
    kind: CURRENT_SHOW_PACKAGE_POINTER_KIND,
    packageId: requirePackageId(raw.packageId, 'packageId', code),
    packageManifestSha256: requireRevisionId(
      raw.packageManifestSha256,
      'packageManifestSha256',
      code
    ),
    projectId: requireSafeId(raw.projectId, 'projectId', code),
    projectRevisionId: requireRevisionId(
      raw.projectRevisionId,
      'projectRevisionId',
      code
    ),
    projectRevision: requireProjectRevision(
      raw.projectRevision,
      'projectRevision',
      code
    ),
    serviceDate: requireServiceDate(raw.serviceDate, 'serviceDate', code),
    venueProfileId: requireSafeId(raw.venueProfileId, 'venueProfileId', code),
    venueProfileRevisionId: requireRevisionId(
      raw.venueProfileRevisionId,
      'venueProfileRevisionId',
      code
    ),
    activationId: requireActivationId(
      raw.activationId,
      'activationId',
      code
    ),
    activatedAt: requireTimestamp(raw.activatedAt, 'activatedAt', code)
  });
}

function serializeCurrentShowPackagePointer(raw) {
  const pointer = normalizeCurrentShowPackagePointer(raw);
  return `${JSON.stringify(pointer, null, 2)}\n`;
}

class CurrentShowPackageStore {
  constructor(options = {}) {
    if (typeof options.rootPath !== 'string' || !path.isAbsolute(options.rootPath)) {
      throw new TypeError('CurrentShowPackageStore requires an absolute rootPath');
    }
    if (options.clock !== undefined && typeof options.clock !== 'function') {
      throw new TypeError('CurrentShowPackageStore clock must be a function');
    }
    if (options.randomUUID !== undefined && typeof options.randomUUID !== 'function') {
      throw new TypeError('CurrentShowPackageStore randomUUID must be a function');
    }
    if (options.atomicWrite !== undefined && typeof options.atomicWrite !== 'function') {
      throw new TypeError('CurrentShowPackageStore atomicWrite must be a function');
    }
    if (options.syncDirectory !== undefined && typeof options.syncDirectory !== 'function') {
      throw new TypeError('CurrentShowPackageStore syncDirectory must be a function');
    }
    this.rootPath = path.resolve(options.rootPath);
    this.clock = options.clock || (() => new Date());
    this.randomUUID = options.randomUUID || (() => crypto.randomUUID());
    this.atomicWrite = options.atomicWrite || atomicWriteFile;
    this.syncDirectory = options.syncDirectory || fsyncDirectory;
  }

  async initialize() {
    this.rootPath = await ensurePrivateDirectory(this.rootPath);
    return this;
  }

  _pointerPath() {
    return path.join(this.rootPath, CURRENT_SHOW_PACKAGE_POINTER_FILE);
  }

  _lockPath() {
    return path.join(this.rootPath, '.current-show-package.lock');
  }

  async _readInitialized() {
    const pointerPath = this._pointerPath();
    let stats;
    try {
      stats = await fs.lstat(pointerPath);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      fail(
        'CURRENT_SHOW_PACKAGE_POINTER_UNREADABLE',
        'The current prepared-service pointer could not be inspected.',
        { cause: error.code || error.message }
      );
    }
    if (!stats.isFile() || stats.isSymbolicLink()) {
      fail(
        'CURRENT_SHOW_PACKAGE_POINTER_UNSAFE',
        'The current prepared-service pointer is not a safe regular file.'
      );
    }

    let source;
    try {
      const { buffer } = await readFileNoFollow(
        pointerPath,
        MAX_CURRENT_SHOW_PACKAGE_POINTER_BYTES
      );
      source = buffer.toString('utf8');
    } catch (error) {
      fail(
        'CURRENT_SHOW_PACKAGE_POINTER_UNREADABLE',
        'The current prepared-service pointer could not be read safely.',
        { cause: error.code || error.message }
      );
    }

    try {
      return normalizeCurrentShowPackagePointer(JSON.parse(source));
    } catch (error) {
      if (error instanceof CurrentShowPackageError) throw error;
      fail(
        'CURRENT_SHOW_PACKAGE_POINTER_INVALID',
        'The current prepared-service pointer is not valid JSON.',
        { cause: error.message }
      );
    }
  }

  async read() {
    await this.initialize();
    return this._readInitialized();
  }

  async activateWithReceipt(rawActivation) {
    const activation = normalizeActivation(rawActivation);
    const now = this.clock();
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
      fail(
        'INVALID_CURRENT_SHOW_PACKAGE_ACTIVATION',
        'Current package activation requires a valid clock value.'
      );
    }
    const pointer = normalizeCurrentShowPackagePointer({
      schemaVersion: CURRENT_SHOW_PACKAGE_POINTER_SCHEMA_VERSION,
      kind: CURRENT_SHOW_PACKAGE_POINTER_KIND,
      ...activation,
      activationId: requireActivationId(
        this.randomUUID(),
        'activationId',
        'INVALID_CURRENT_SHOW_PACKAGE_ACTIVATION'
      ),
      activatedAt: now.toISOString()
    });

    await this.initialize();
    let receipt = null;
    try {
      await withExclusiveFileLock(this._lockPath(), async () => {
        let previousPointer = null;
        try {
          previousPointer = await this._readInitialized();
        } catch (error) {
          if (error?.code !== 'CURRENT_SHOW_PACKAGE_POINTER_INVALID') throw error;
        }
        receipt = Object.freeze({
          pointer,
          previousPointer
        });
        await this.atomicWrite(
          this._pointerPath(),
          serializeCurrentShowPackagePointer(pointer),
          {
            maximumBytes: MAX_CURRENT_SHOW_PACKAGE_POINTER_BYTES,
            mode: 0o600,
            rootPath: this.rootPath
          }
        );
      });
    } catch (error) {
      // atomicWriteFile publishes by rename before its final directory fsync,
      // and lock cleanup also runs after the operation. If either reports an
      // error after the exact pointer became visible, retry the durability
      // barrier and return the receipt instead of falsely reporting failure.
      const visible = receipt
        ? await this._readInitialized().catch(() => null)
        : null;
      if (
        visible
        && visible.packageId === pointer.packageId
        && visible.activationId === pointer.activationId
      ) {
        try {
          await this.syncDirectory(this.rootPath);
          return receipt;
        } catch (durabilityError) {
          fail(
            'CURRENT_SHOW_PACKAGE_ACTIVATION_UNCERTAIN',
            'The prepared-service pointer changed, but its restart durability could not be confirmed.',
            {
              packageId: pointer.packageId,
              activationId: pointer.activationId,
              cause: durabilityError.code || durabilityError.message
            }
          );
        }
      }
      throw error;
    }
    return receipt;
  }

  async activate(rawActivation) {
    const receipt = await this.activateWithReceipt(rawActivation);
    return receipt.pointer;
  }

  async rollbackActivation(rawReceipt) {
    requireExactDataProperties(
      rawReceipt,
      ACTIVATION_RECEIPT_KEYS,
      'Current package activation receipt',
      'INVALID_CURRENT_SHOW_PACKAGE_ROLLBACK'
    );
    const pointer = normalizeCurrentShowPackagePointer(rawReceipt.pointer);
    const previousPointer = rawReceipt.previousPointer === null
      ? null
      : normalizeCurrentShowPackagePointer(rawReceipt.previousPointer);

    await this.initialize();
    return withExclusiveFileLock(this._lockPath(), async () => {
      const current = await this._readInitialized();
      if (
        !current
        || current.packageId !== pointer.packageId
        || current.activationId !== pointer.activationId
      ) {
        return false;
      }
      if (previousPointer) {
        await this.atomicWrite(
          this._pointerPath(),
          serializeCurrentShowPackagePointer(previousPointer),
          {
            maximumBytes: MAX_CURRENT_SHOW_PACKAGE_POINTER_BYTES,
            mode: 0o600,
            rootPath: this.rootPath
          }
        );
        return true;
      }
      await fs.unlink(this._pointerPath());
      await this.syncDirectory(this.rootPath).catch(error => {
        if (process.platform !== 'win32'
          || !['EINVAL', 'EPERM', 'EBADF', 'EACCES'].includes(error.code)) {
          throw error;
        }
      });
      return true;
    });
  }

  async clear(options = {}) {
    const hasExpectedPackageId = isPlainRecord(options)
      && Object.hasOwn(options, 'expectedPackageId');
    const hasExpectedActivationId = isPlainRecord(options)
      && Object.hasOwn(options, 'expectedActivationId');
    requireExactDataProperties(
      options,
      [
        ...(hasExpectedPackageId ? ['expectedPackageId'] : []),
        ...(hasExpectedActivationId ? ['expectedActivationId'] : [])
      ],
      'Current package clear request',
      'INVALID_CURRENT_SHOW_PACKAGE_CLEAR'
    );
    if (hasExpectedActivationId && !hasExpectedPackageId) {
      fail(
        'INVALID_CURRENT_SHOW_PACKAGE_CLEAR',
        'An activation guard requires its exact package id.'
      );
    }
    const expectedPackageId = hasExpectedPackageId
      ? requirePackageId(
          options.expectedPackageId,
          'expectedPackageId',
          'INVALID_CURRENT_SHOW_PACKAGE_CLEAR'
        )
      : null;
    const expectedActivationId = hasExpectedActivationId
      ? requireActivationId(
          options.expectedActivationId,
          'expectedActivationId',
          'INVALID_CURRENT_SHOW_PACKAGE_CLEAR'
        )
      : null;

    await this.initialize();
    return withExclusiveFileLock(this._lockPath(), async () => {
      const pointerPath = this._pointerPath();
      if (expectedPackageId) {
        const current = await this._readInitialized();
        if (!current
          || current.packageId !== expectedPackageId
          || (
            expectedActivationId
            && current.activationId !== expectedActivationId
          )) {
          return false;
        }
      }
      let stats;
      try {
        stats = await fs.lstat(pointerPath);
      } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
      }
      if (!stats.isFile() || stats.isSymbolicLink()) {
        fail(
          'CURRENT_SHOW_PACKAGE_POINTER_UNSAFE',
          'The current prepared-service pointer changed before it could be cleared.'
        );
      }
      await fs.unlink(pointerPath);
      await this.syncDirectory(this.rootPath).catch(error => {
        if (process.platform !== 'win32'
          || !['EINVAL', 'EPERM', 'EBADF', 'EACCES'].includes(error.code)) {
          throw error;
        }
      });
      return true;
    });
  }
}

module.exports = {
  CURRENT_SHOW_PACKAGE_POINTER_KIND,
  CURRENT_SHOW_PACKAGE_POINTER_SCHEMA_VERSION,
  CurrentShowPackageError,
  CurrentShowPackageStore,
  normalizeCurrentShowPackagePointer,
  serializeCurrentShowPackagePointer
};
