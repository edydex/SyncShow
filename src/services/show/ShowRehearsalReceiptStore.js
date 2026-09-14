'use strict';

const fs = require('fs/promises');
const path = require('path');

const {
  MAX_SHOW_REHEARSAL_RECEIPT_BYTES,
  normalizeShowRehearsalReceipt,
  parseShowRehearsalReceipt,
  serializeShowRehearsalReceipt
} = require('./ShowRehearsalReceipt');
const {
  atomicWriteFile,
  ensurePrivateDirectory,
  fsyncDirectory,
  readFileNoFollow
} = require('../project/StorageSafety');

const SHOW_REHEARSAL_RECEIPT_FILE = 'rehearsal-receipt.json';

class ShowRehearsalReceiptStoreError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ShowRehearsalReceiptStoreError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function fail(code, message, details = {}) {
  throw new ShowRehearsalReceiptStoreError(code, message, details);
}

function errorCause(error, fallback) {
  return error?.code || error?.name || fallback;
}

function sameReceipt(left, right) {
  try {
    return serializeShowRehearsalReceipt(left)
      === serializeShowRehearsalReceipt(right);
  } catch (_error) {
    return false;
  }
}

class ShowRehearsalReceiptStore {
  constructor(options = {}) {
    if (
      typeof options.rootPath !== 'string'
      || !path.isAbsolute(options.rootPath)
    ) {
      throw new TypeError(
        'ShowRehearsalReceiptStore requires an absolute rootPath'
      );
    }
    if (
      options.atomicWrite !== undefined
      && typeof options.atomicWrite !== 'function'
    ) {
      throw new TypeError(
        'ShowRehearsalReceiptStore atomicWrite must be a function'
      );
    }
    if (
      options.syncDirectory !== undefined
      && typeof options.syncDirectory !== 'function'
    ) {
      throw new TypeError(
        'ShowRehearsalReceiptStore syncDirectory must be a function'
      );
    }
    this.rootPath = path.resolve(options.rootPath);
    this.atomicWrite = options.atomicWrite || atomicWriteFile;
    this.syncDirectory = options.syncDirectory || fsyncDirectory;
    this.writeQueue = Promise.resolve();
  }

  async initialize() {
    try {
      this.rootPath = await ensurePrivateDirectory(this.rootPath);
    } catch (error) {
      fail(
        'SHOW_REHEARSAL_RECEIPT_STORE_UNSAFE',
        'The rehearsal receipt storage folder is unsafe.',
        { cause: errorCause(error, 'unsafe-root') }
      );
    }
    return this;
  }

  _receiptPath() {
    return path.join(this.rootPath, SHOW_REHEARSAL_RECEIPT_FILE);
  }

  _serialize(operation) {
    const result = this.writeQueue.then(operation, operation);
    this.writeQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  async _syncRoot() {
    try {
      await this.syncDirectory(this.rootPath);
    } catch (error) {
      if (
        process.platform !== 'win32'
        || !['EINVAL', 'EPERM', 'EBADF', 'EACCES'].includes(error.code)
      ) {
        throw error;
      }
    }
  }

  async _readInitialized() {
    const receiptPath = this._receiptPath();
    let stats;
    try {
      stats = await fs.lstat(receiptPath);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      fail(
        'SHOW_REHEARSAL_RECEIPT_STORE_UNREADABLE',
        'The saved rehearsal receipt could not be inspected safely.',
        { cause: errorCause(error, 'inspect-failed') }
      );
    }
    if (
      !stats.isFile()
      || stats.isSymbolicLink()
      || (
        process.platform !== 'win32'
        && (stats.mode & 0o077) !== 0
      )
    ) {
      fail(
        'SHOW_REHEARSAL_RECEIPT_STORE_UNSAFE',
        'The saved rehearsal receipt is not a private regular file.'
      );
    }
    if (stats.size > MAX_SHOW_REHEARSAL_RECEIPT_BYTES) {
      fail(
        'SHOW_REHEARSAL_RECEIPT_STORE_CORRUPT',
        'The saved rehearsal receipt exceeds its byte limit.'
      );
    }

    let source;
    try {
      const { buffer } = await readFileNoFollow(
        receiptPath,
        MAX_SHOW_REHEARSAL_RECEIPT_BYTES
      );
      source = buffer.toString('utf8');
    } catch (error) {
      fail(
        'SHOW_REHEARSAL_RECEIPT_STORE_UNREADABLE',
        'The saved rehearsal receipt could not be read safely.',
        { cause: errorCause(error, 'read-failed') }
      );
    }

    try {
      return parseShowRehearsalReceipt(source);
    } catch (error) {
      fail(
        'SHOW_REHEARSAL_RECEIPT_STORE_CORRUPT',
        'The saved rehearsal receipt is invalid or noncanonical.',
        { causeCode: error.code || null }
      );
    }
  }

  async read() {
    await this.initialize();
    return this._readInitialized();
  }

  write(rawReceipt) {
    const receipt = normalizeShowRehearsalReceipt(rawReceipt);
    const source = serializeShowRehearsalReceipt(receipt);
    return this._serialize(async () => {
      await this.initialize();
      try {
        await this.atomicWrite(this._receiptPath(), source, {
          maximumBytes: MAX_SHOW_REHEARSAL_RECEIPT_BYTES,
          mode: 0o600,
          rootPath: this.rootPath
        });
      } catch (error) {
        const visible = await this._readInitialized().catch(() => null);
        if (visible && sameReceipt(visible, receipt)) {
          try {
            await this._syncRoot();
            return receipt;
          } catch (durabilityError) {
            fail(
              'SHOW_REHEARSAL_RECEIPT_STORE_WRITE_UNCERTAIN',
              'The rehearsal receipt is visible, but its restart durability could not be confirmed.',
              {
                cause: errorCause(
                  durabilityError,
                  'durability-check-failed'
                )
              }
            );
          }
        }
        fail(
          'SHOW_REHEARSAL_RECEIPT_STORE_WRITE_FAILED',
          'The rehearsal receipt could not be saved durably.',
          { cause: errorCause(error, 'write-failed') }
        );
      }
      return receipt;
    });
  }

  clear() {
    return this._serialize(async () => {
      await this.initialize();
      const receiptPath = this._receiptPath();
      let stats;
      try {
        stats = await fs.lstat(receiptPath);
      } catch (error) {
        if (error.code === 'ENOENT') return false;
        fail(
          'SHOW_REHEARSAL_RECEIPT_STORE_CLEAR_FAILED',
          'The rehearsal receipt could not be inspected before clearing.',
          { cause: errorCause(error, 'inspect-failed') }
        );
      }
      if (!stats.isFile() || stats.isSymbolicLink()) {
        fail(
          'SHOW_REHEARSAL_RECEIPT_STORE_UNSAFE',
          'The rehearsal receipt changed before it could be cleared.'
        );
      }
      try {
        await fs.unlink(receiptPath);
        await this._syncRoot();
      } catch (error) {
        fail(
          'SHOW_REHEARSAL_RECEIPT_STORE_CLEAR_FAILED',
          'The rehearsal receipt could not be cleared durably.',
          { cause: errorCause(error, 'clear-failed') }
        );
      }
      return true;
    });
  }
}

module.exports = {
  SHOW_REHEARSAL_RECEIPT_FILE,
  ShowRehearsalReceiptStore,
  ShowRehearsalReceiptStoreError
};
