'use strict';

const crypto = require('node:crypto');
const path = require('node:path');

const {
  atomicWriteFile,
  ensurePrivateDirectory,
  readFileNoFollow
} = require('../project/StorageSafety');

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const MAX_PLAINTEXT_BYTES = 128 * 1024;
const PAYLOAD_MAGIC = Buffer.from('SyncShowCommunityLocalCredentialV1\0', 'utf8');
const PAYLOAD_AAD = Buffer.from('SyncShow Community credential vault v1', 'utf8');

function storageError(code, message, cause = null) {
  const error = new Error(message);
  error.name = 'AppLocalCredentialStorageError';
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

class AppLocalCredentialStorage {
  constructor({ storageRoot, randomBytes = crypto.randomBytes } = {}) {
    if (typeof storageRoot !== 'string' || !path.isAbsolute(storageRoot)) {
      throw new TypeError('Community credential storage root must be an absolute path');
    }
    if (typeof randomBytes !== 'function') {
      throw new TypeError('Community credential randomness provider is invalid');
    }
    this.storageRoot = path.resolve(storageRoot);
    this.keyPath = path.join(this.storageRoot, 'device.key');
    this.randomBytes = randomBytes;
    this.keyPromise = null;
  }

  async _loadOrCreateKey() {
    await ensurePrivateDirectory(this.storageRoot);
    try {
      const { buffer, stats } = await readFileNoFollow(this.keyPath, KEY_BYTES);
      if (buffer.length !== KEY_BYTES) {
        throw storageError(
          'CREDENTIAL_STORAGE_INVALID',
          'Community credential key is invalid.'
        );
      }
      if (process.platform !== 'win32' && (stats.mode & 0o077) !== 0) {
        throw storageError(
          'CREDENTIAL_STORAGE_INVALID',
          'Community credential key permissions are unsafe.'
        );
      }
      return buffer;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    const key = this.randomBytes(KEY_BYTES);
    if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
      throw storageError(
        'CREDENTIAL_STORAGE_INVALID',
        'Community credential key could not be created.'
      );
    }
    await atomicWriteFile(this.keyPath, key, {
      rootPath: this.storageRoot,
      maximumBytes: KEY_BYTES,
      mode: 0o600
    });
    return key;
  }

  async _key() {
    if (!this.keyPromise) {
      this.keyPromise = this._loadOrCreateKey().catch(error => {
        this.keyPromise = null;
        throw error;
      });
    }
    return this.keyPromise;
  }

  async isAsyncEncryptionAvailable() {
    await this._key();
    return true;
  }

  async encryptStringAsync(plaintext) {
    if (typeof plaintext !== 'string'
      || Buffer.byteLength(plaintext, 'utf8') > MAX_PLAINTEXT_BYTES) {
      throw storageError(
        'CREDENTIAL_STORAGE_INVALID',
        'Community credentials are invalid.'
      );
    }
    const key = await this._key();
    const nonce = this.randomBytes(NONCE_BYTES);
    if (!Buffer.isBuffer(nonce) || nonce.length !== NONCE_BYTES) {
      throw storageError(
        'CREDENTIAL_STORAGE_INVALID',
        'Community credential nonce could not be created.'
      );
    }
    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(PAYLOAD_AAD);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final()
    ]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([PAYLOAD_MAGIC, nonce, tag, ciphertext]);
  }

  async decryptStringAsync(payload) {
    const minimumBytes = PAYLOAD_MAGIC.length + NONCE_BYTES + TAG_BYTES;
    if (!Buffer.isBuffer(payload)
      || payload.length < minimumBytes
      || !payload.subarray(0, PAYLOAD_MAGIC.length).equals(PAYLOAD_MAGIC)) {
      throw storageError(
        'CREDENTIAL_RECONNECT_REQUIRED',
        'Reconnect Heritage Community with your Community admin account.'
      );
    }
    try {
      const key = await this._key();
      const nonceOffset = PAYLOAD_MAGIC.length;
      const tagOffset = nonceOffset + NONCE_BYTES;
      const ciphertextOffset = tagOffset + TAG_BYTES;
      const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        key,
        payload.subarray(nonceOffset, tagOffset)
      );
      decipher.setAAD(PAYLOAD_AAD);
      decipher.setAuthTag(payload.subarray(tagOffset, ciphertextOffset));
      const plaintext = Buffer.concat([
        decipher.update(payload.subarray(ciphertextOffset)),
        decipher.final()
      ]).toString('utf8');
      return { result: plaintext };
    } catch (error) {
      if (error?.code === 'CREDENTIAL_RECONNECT_REQUIRED') throw error;
      throw storageError(
        'CREDENTIAL_RECONNECT_REQUIRED',
        'Reconnect Heritage Community with your Community admin account.',
        error
      );
    }
  }
}

module.exports = {
  AppLocalCredentialStorage,
  KEY_BYTES,
  PAYLOAD_MAGIC
};
