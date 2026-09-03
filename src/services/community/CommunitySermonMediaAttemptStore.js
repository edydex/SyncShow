'use strict';

const crypto = require('crypto');
const path = require('path');

const {
  atomicWriteFile,
  ensurePrivateDirectory,
  readFileNoFollow
} = require('../project/StorageSafety');

const SCHEMA_VERSION = 3;
const LEGACY_SCHEMA_VERSION = 1;
const INTERMEDIATE_SCHEMA_VERSION = 2;
const MAX_STORE_BYTES = 1024 * 1024;
const MAX_ATTEMPTS = 10_000;
const MAX_LOCATORS_PER_ATTEMPT = 32;
const KEY_PATTERN = /^[a-f0-9]{64}$/u;
const ATTEMPT_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const UPLOAD_PATTERN = /^[A-Za-z0-9_-]{32,128}$/u;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const REVISION_PATTERN = /^[a-f0-9]{64}$/u;
const LANGUAGE_PATTERN = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/u;

class CommunitySermonMediaAttemptStore {
  constructor({
    rootPath,
    randomUUID = crypto.randomUUID,
    now = () => new Date()
  } = {}) {
    if (typeof rootPath !== 'string' || !path.isAbsolute(rootPath)) {
      throw new TypeError('Sermon-media attempt store requires an absolute root');
    }
    if (typeof randomUUID !== 'function' || typeof now !== 'function') {
      throw new TypeError('Sermon-media attempt store dependencies are invalid');
    }
    this.rootPath = path.resolve(rootPath);
    this.storePath = path.join(this.rootPath, 'attempts.json');
    this.randomUUID = randomUUID;
    this.now = now;
    this.queue = Promise.resolve();
  }

  _serialize(operation) {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  _key(value) {
    if (typeof value !== 'string' || !KEY_PATTERN.test(value)) {
      throw new TypeError('Sermon-media attempt binding key is invalid');
    }
    return value;
  }

  _timestamp() {
    const value = this.now();
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new TypeError('Sermon-media attempt clock is invalid');
    }
    return date.toISOString();
  }

  _snapshot(attempt) {
    return attempt
      ? Object.freeze({
          ...attempt,
          binding: attempt.binding
            ? Object.freeze({
                ...attempt.binding,
                recording: Object.freeze({
                  ...attempt.binding.recording
                })
              })
            : null,
          locatorKeys: Object.freeze([...attempt.locatorKeys])
        })
      : null;
  }

  _binding(value) {
    if (value === null || value === undefined) return null;
    if (!value
      || typeof value !== 'object'
      || Array.isArray(value)
      || Object.keys(value).sort().join('\n')
        !== 'expectedCurrentRevision\nexpectedSyncVersion\nrecording\nsermonId') {
      throw new TypeError('Sermon-media recovery binding is invalid');
    }
    const recording = value.recording;
    if (!recording
      || typeof recording !== 'object'
      || Array.isArray(recording)
      || Object.keys(recording).sort().join('\n')
        !== [
          'durationSeconds',
          'fileName',
          'id',
          'kind',
          'language',
          'mediaType',
          'sha256',
          'sizeBytes'
        ].sort().join('\n')
      || recording.kind !== 'audio'
      || !['audio/mpeg', 'audio/mp4'].includes(recording.mediaType)
      || !ID_PATTERN.test(recording.id || '')
      || !LANGUAGE_PATTERN.test(recording.language || '')
      || typeof recording.fileName !== 'string'
      || !recording.fileName
      || recording.fileName.length > 255
      || recording.fileName.includes('/')
      || recording.fileName.includes('\\')
      || /^[A-Za-z]:/u.test(recording.fileName)
      || !REVISION_PATTERN.test(recording.sha256 || '')
      || !Number.isSafeInteger(recording.sizeBytes)
      || recording.sizeBytes < 1
      || recording.sizeBytes > 1_073_741_824
      || recording.durationSeconds !== null
      || !ID_PATTERN.test(value.sermonId || '')
      || !Number.isSafeInteger(value.expectedSyncVersion)
      || value.expectedSyncVersion < 1
      || !REVISION_PATTERN.test(value.expectedCurrentRevision || '')) {
      throw new TypeError('Sermon-media recovery binding is invalid');
    }
    return {
      sermonId: value.sermonId,
      expectedSyncVersion: value.expectedSyncVersion,
      expectedCurrentRevision: value.expectedCurrentRevision,
      recording: {
        id: recording.id,
        kind: 'audio',
        language: recording.language,
        mediaType: recording.mediaType,
        fileName: recording.fileName,
        sha256: recording.sha256,
        sizeBytes: recording.sizeBytes,
        durationSeconds: null
      }
    };
  }

  async _read() {
    await ensurePrivateDirectory(this.rootPath);
    let buffer;
    try {
      ({ buffer } = await readFileNoFollow(this.storePath, MAX_STORE_BYTES));
    } catch (error) {
      if (error.code === 'ENOENT') return {};
      throw error;
    }
    const payload = JSON.parse(buffer.toString('utf8'));
    if (!payload
      || ![
        LEGACY_SCHEMA_VERSION,
        INTERMEDIATE_SCHEMA_VERSION,
        SCHEMA_VERSION
      ]
        .includes(payload.schemaVersion)
      || !payload.attempts
      || typeof payload.attempts !== 'object'
      || Array.isArray(payload.attempts)
      || Object.keys(payload.attempts).length > MAX_ATTEMPTS) {
      throw new Error('Saved sermon-media attempts are invalid');
    }
    const legacy = payload.schemaVersion === LEGACY_SCHEMA_VERSION;
    const intermediate =
      payload.schemaVersion === INTERMEDIATE_SCHEMA_VERSION;
    const attempts = {};
    for (const [key, value] of Object.entries(payload.attempts)) {
      if (!KEY_PATTERN.test(key)
        || !value
        || typeof value !== 'object'
        || Array.isArray(value)
        || Object.keys(value).sort().join('\n')
          !== (legacy
            ? 'attemptId\nterminal\nupdatedAt'
            : intermediate
              ? 'attemptId\nterminal\nupdatedAt\nuploadId'
              : 'attemptId\nbinding\nlocatorKeys\nterminal\nupdatedAt\nuploadId')
        || !ATTEMPT_PATTERN.test(value.attemptId || '')
        || (!legacy
          && value.uploadId !== null
          && !UPLOAD_PATTERN.test(value.uploadId || ''))
        || (!legacy
          && !intermediate
          && (value.binding !== null
            && (() => {
              try {
                this._binding(value.binding);
                return false;
              } catch (_error) {
                return true;
              }
            })()))
        || (!legacy
          && !intermediate
          && (!Array.isArray(value.locatorKeys)
            || value.locatorKeys.length > MAX_LOCATORS_PER_ATTEMPT
            || value.locatorKeys.some(locator => !KEY_PATTERN.test(locator))
            || new Set(value.locatorKeys).size !== value.locatorKeys.length))
        || typeof value.terminal !== 'boolean'
        || typeof value.updatedAt !== 'string'
        || Number.isNaN(Date.parse(value.updatedAt))) {
        throw new Error('Saved sermon-media attempts are invalid');
      }
      attempts[key] = {
        attemptId: value.attemptId,
        uploadId: legacy ? null : value.uploadId,
        binding: legacy || intermediate
          ? null
          : this._binding(value.binding),
        locatorKeys: legacy || intermediate ? [] : [...value.locatorKeys],
        terminal: value.terminal,
        updatedAt: new Date(value.updatedAt).toISOString()
      };
    }
    return attempts;
  }

  async _write(attempts) {
    const bounded = this._boundedAttempts(attempts);
    const source = `${JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      attempts: bounded
    }, null, 2)}\n`;
    await atomicWriteFile(this.storePath, source, {
      rootPath: this.rootPath,
      maximumBytes: MAX_STORE_BYTES,
      mode: 0o600
    });
  }

  _locator(value) {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'string' || !KEY_PATTERN.test(value)) {
      throw new TypeError('Sermon-media recovery locator is invalid');
    }
    return value;
  }

  _boundedAttempts(attempts) {
    const entries = Object.entries(attempts).sort((left, right) => {
      if (left[1].terminal !== right[1].terminal) {
        return left[1].terminal ? 1 : -1;
      }
      return Date.parse(right[1].updatedAt)
        - Date.parse(left[1].updatedAt);
    });
    const active = entries.filter(([, attempt]) => !attempt.terminal);
    if (active.length > MAX_ATTEMPTS) {
      throw new Error('Too many active sermon-media attempts are saved');
    }
    const terminal = entries
      .filter(([, attempt]) => attempt.terminal)
      .slice(0, Math.max(0, MAX_ATTEMPTS - active.length));
    const byteLengthFor = terminalCount => Buffer.byteLength(
      `${JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        attempts: Object.fromEntries([
          ...active,
          ...terminal.slice(0, terminalCount)
        ])
      }, null, 2)}\n`,
      'utf8'
    );
    if (byteLengthFor(0) > MAX_STORE_BYTES) {
      throw new Error(
        'Active sermon-media recovery attempts exceed safe local storage'
      );
    }
    let lower = 0;
    let upper = terminal.length;
    while (lower < upper) {
      const middle = Math.ceil((lower + upper) / 2);
      if (byteLengthFor(middle) <= MAX_STORE_BYTES) {
        lower = middle;
      } else {
        upper = middle - 1;
      }
    }
    return Object.fromEntries([
      ...active,
      ...terminal.slice(0, lower)
    ]);
  }

  attemptFor(rawKey, {
    rotateTerminal = false,
    recoveryLocator = null,
    recoveryBinding = null
  } = {}) {
    const key = this._key(rawKey);
    const locator = this._locator(recoveryLocator);
    const binding = this._binding(recoveryBinding);
    return this._serialize(async () => {
      const attempts = await this._read();
      const previous = attempts[key] || null;
      if (previous && !(rotateTerminal && previous.terminal)) {
        let changed = false;
        if (binding) {
          if (previous.binding
            && JSON.stringify(previous.binding) !== JSON.stringify(binding)) {
            throw new Error(
              'This sermon-media attempt has a different recovery binding'
            );
          }
          if (!previous.binding) {
            previous.binding = binding;
            changed = true;
          }
        }
        if (locator && !previous.locatorKeys.includes(locator)) {
          if (previous.locatorKeys.length >= MAX_LOCATORS_PER_ATTEMPT) {
            throw new Error(
              'This sermon-media attempt has too many recovery locations'
            );
          }
          previous.locatorKeys.push(locator);
          previous.locatorKeys.sort();
          changed = true;
        }
        if (changed) {
          previous.updatedAt = this._timestamp();
          await this._write(attempts);
        }
        return this._snapshot(previous);
      }
      const attemptId = String(this.randomUUID()).toLowerCase();
      if (!ATTEMPT_PATTERN.test(attemptId)) {
        throw new TypeError('Sermon-media attempt generator is invalid');
      }
      const attempt = {
        attemptId,
        uploadId: null,
        binding,
        locatorKeys: locator ? [locator] : [],
        terminal: false,
        updatedAt: this._timestamp()
      };
      attempts[key] = attempt;
      await this._write(attempts);
      return this._snapshot(attempt);
    });
  }

  readAttempt(rawKey) {
    const key = this._key(rawKey);
    return this._serialize(async () => {
      const attempts = await this._read();
      const attempt = attempts[key] || null;
      return this._snapshot(attempt);
    });
  }

  readRecoverable(rawLocator) {
    const locator = this._locator(rawLocator);
    return this._serialize(async () => {
      const attempts = await this._read();
      return Object.freeze(
        Object.entries(attempts)
          .filter(([, attempt]) =>
            !attempt.terminal
            && attempt.binding
            && attempt.locatorKeys.includes(locator))
          .sort((left, right) =>
            Date.parse(right[1].updatedAt)
              - Date.parse(left[1].updatedAt))
          .map(([attemptKey, attempt]) => {
            const snapshot = this._snapshot(attempt);
            return Object.freeze({ attemptKey, ...snapshot });
          })
      );
    });
  }

  acknowledgeUpload(rawKey, attemptId, uploadId) {
    const key = this._key(rawKey);
    if (typeof attemptId !== 'string' || !ATTEMPT_PATTERN.test(attemptId)) {
      throw new TypeError('Sermon-media attempt identity is invalid');
    }
    if (typeof uploadId !== 'string' || !UPLOAD_PATTERN.test(uploadId)) {
      throw new TypeError('Sermon-media upload identity is invalid');
    }
    return this._serialize(async () => {
      const attempts = await this._read();
      const current = attempts[key];
      if (!current
        || current.attemptId !== attemptId
        || current.terminal) {
        throw new Error(
          'The acknowledged sermon-media upload has no active local attempt'
        );
      }
      if (current.uploadId && current.uploadId !== uploadId) {
        throw new Error(
          'Community changed the upload identity for an existing sermon-media attempt'
        );
      }
      if (current.uploadId === uploadId) {
        return Object.freeze({
          changed: false,
          attempt: this._snapshot(current)
        });
      }
      current.uploadId = uploadId;
      current.updatedAt = this._timestamp();
      await this._write(attempts);
      return Object.freeze({
        changed: true,
        attempt: this._snapshot(current)
      });
    });
  }

  markTerminal(rawKey, attemptId) {
    const key = this._key(rawKey);
    if (typeof attemptId !== 'string' || !ATTEMPT_PATTERN.test(attemptId)) {
      throw new TypeError('Sermon-media attempt identity is invalid');
    }
    return this._serialize(async () => {
      const attempts = await this._read();
      const current = attempts[key];
      if (!current || current.attemptId !== attemptId || current.terminal) {
        return Object.freeze({
          changed: false,
          attempt: this._snapshot(current)
        });
      }
      current.terminal = true;
      current.updatedAt = this._timestamp();
      await this._write(attempts);
      return Object.freeze({
        changed: true,
        attempt: this._snapshot(current)
      });
    });
  }
}

function sermonMediaAttemptBindingKey(binding, {
  serverId,
  communityId
} = {}) {
  let serverOrigin;
  try {
    const parsed = new URL(serverId);
    const loopback = parsed.protocol === 'http:'
      && (
        parsed.hostname === 'localhost'
        || parsed.hostname === '::1'
        || /^127(?:\.\d{1,3}){3}$/u.test(parsed.hostname)
      );
    if ((parsed.protocol !== 'https:' && !loopback)
      || parsed.username
      || parsed.password
      || parsed.search
      || parsed.hash
      || parsed.pathname !== '/') {
      throw new Error('invalid');
    }
    serverOrigin = parsed.origin;
  } catch (_error) {
    throw new TypeError('Sermon-media attempt server identity is invalid');
  }
  if (typeof communityId !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(communityId)) {
    throw new TypeError('Sermon-media attempt Community identity is invalid');
  }
  return crypto.createHash('sha256').update(JSON.stringify({
    serverId: serverOrigin,
    communityId,
    sermonId: binding.sermonId,
    sermonRevisionId: binding.sermonRevisionId,
    expectedSyncVersion: binding.expectedSyncVersion,
    expectedCurrentRevision: binding.expectedCurrentRevision,
    recordingId: binding.recording.id,
    recordingSha256: binding.recording.sha256,
    recordingSizeBytes: binding.recording.sizeBytes
  })).digest('hex');
}

function sermonMediaAttemptRecoveryLocator(binding, {
  serverId,
  communityId
} = {}) {
  let serverOrigin;
  try {
    const parsed = new URL(serverId);
    const loopback = parsed.protocol === 'http:'
      && (
        parsed.hostname === 'localhost'
        || parsed.hostname === '::1'
        || /^127(?:\.\d{1,3}){3}$/u.test(parsed.hostname)
      );
    if ((parsed.protocol !== 'https:' && !loopback)
      || parsed.username
      || parsed.password
      || parsed.search
      || parsed.hash
      || parsed.pathname !== '/') {
      throw new Error('invalid');
    }
    serverOrigin = parsed.origin;
  } catch (_error) {
    throw new TypeError('Sermon-media attempt server identity is invalid');
  }
  if (typeof communityId !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(communityId)) {
    throw new TypeError('Sermon-media attempt Community identity is invalid');
  }
  for (const [value, label] of [
    [binding?.projectId, 'project'],
    [binding?.itemId, 'item']
  ]) {
    if (typeof value !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) {
      throw new TypeError(
        `Sermon-media attempt ${label} identity is invalid`
      );
    }
  }
  return crypto.createHash('sha256').update(JSON.stringify({
    serverId: serverOrigin,
    communityId,
    projectId: binding.projectId,
    itemId: binding.itemId
  })).digest('hex');
}

module.exports = {
  CommunitySermonMediaAttemptStore,
  sermonMediaAttemptBindingKey,
  sermonMediaAttemptRecoveryLocator
};
