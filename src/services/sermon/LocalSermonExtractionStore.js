'use strict';

const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const { TextDecoder } = require('util');

const {
  normalizeSermonSourceExtractionProposal
} = require('./SermonSourceExtractionProposal');
const {
  atomicWriteFile,
  ensureConfinedDirectory,
  ensurePrivateDirectory,
  readFileNoFollow,
  withExclusiveFileLock
} = require('../project/StorageSafety');

const EXTRACTION_SNAPSHOT_SCHEMA_VERSION = 1;
const EXTRACTION_SNAPSHOT_KIND = 'syncshow-sermon-extraction-snapshot';
const EXTRACTION_BINDING_INDEX_SCHEMA_VERSION = 1;
const EXTRACTION_BINDING_INDEX_KIND = 'syncshow-sermon-extraction-binding-index';
const EXTRACTION_REVIEW_RECEIPT_SCHEMA_VERSION = 1;
const EXTRACTION_REVIEW_RECEIPT_KIND = 'syncshow-sermon-extraction-review-receipt';
const EXTRACTION_REVIEW_INDEX_SCHEMA_VERSION = 1;
const EXTRACTION_REVIEW_INDEX_KIND = 'syncshow-sermon-extraction-review-index';

const MAX_EXTRACTION_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const MAX_EXTRACTION_BINDING_INDEX_BYTES = 64 * 1024;
const MAX_EXTRACTION_REVIEW_RECEIPT_BYTES = 256 * 1024;
const MAX_EXTRACTION_REVIEW_INDEX_BYTES = 256 * 1024;
const MAX_EXTRACTION_SNAPSHOTS = 10_000;
const MAX_EXTRACTION_REVIEW_RECEIPTS = 50_000;
const MAX_REVIEW_RECEIPTS_PER_SNAPSHOT = 1_000;
const MAX_REVIEW_INDEX_ENTRIES = 1_000;
const MAX_SELECTED_SUGGESTIONS = 500;
const MAX_REFERENCE_SCAN_FILES = 200_000;
const MAX_REFERENCE_SCAN_BYTES = 1024 * 1024 * 1024 * 1024;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SOURCE_KINDS = new Set(['manuscript', 'slide-notes', 'transcript', 'other']);
const HASH_FILE_PATTERN = /^([a-f0-9]{64})\.json$/;
const HASH_DIRECTORY_PATTERN = /^[a-f0-9]{64}$/;
const HASH_PREFIX_PATTERN = /^[a-f0-9]{2}$/;

class LocalSermonExtractionStoreError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'LocalSermonExtractionStoreError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function fail(code, message, details = {}) {
  throw new LocalSermonExtractionStoreError(code, message, details);
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, expectedKeys, field, code = 'INVALID_EXTRACTION_STORE_INPUT') {
  if (!isRecord(value)) fail(code, `${field} must be an object.`);
  const actual = Object.keys(value);
  const expected = new Set(expectedKeys);
  if (actual.length !== expected.size || actual.some(key => !expected.has(key))) {
    fail(code, `${field} has unsupported or missing fields.`);
  }
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

function canonicalEqual(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function identifier(value, field, code = 'INVALID_EXTRACTION_STORE_INPUT') {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    fail(code, `${field} must be a canonical identifier.`);
  }
  return value;
}

function revision(value, field, code = 'INVALID_EXTRACTION_STORE_INPUT') {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    fail(code, `${field} must be a lowercase SHA-256 digest.`);
  }
  return value;
}

function sourceKind(value, field, code = 'INVALID_EXTRACTION_STORE_INPUT') {
  if (!SOURCE_KINDS.has(value)) fail(code, `${field} is unsupported.`);
  return value;
}

function extractorId(value, field, code = 'INVALID_EXTRACTION_STORE_INPUT') {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128) {
    fail(code, `${field} must be bounded text.`);
  }
  return value;
}

function extractorVersion(value, field, code = 'INVALID_EXTRACTION_STORE_INPUT') {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000_000) {
    fail(code, `${field} must be a bounded positive integer.`);
  }
  return value;
}

function canonicalTimestamp(value, field, code = 'INVALID_REVIEW_RECEIPT') {
  if (
    typeof value !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) {
    fail(code, `${field} must be a canonical ISO-8601 UTC timestamp.`);
  }
  return value;
}

function capacityOption(value, fallback, maximum, label) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${label} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

function normalizeBinding(raw, code = 'INVALID_EXTRACTION_BINDING') {
  exactKeys(raw, [
    'sermonId',
    'baseSermonRevisionId',
    'sourceId',
    'sourceSha256',
    'sourceKind',
    'extractorId',
    'extractorVersion'
  ], 'Extraction binding', code);
  return deepFreeze({
    sermonId: identifier(raw.sermonId, 'Extraction binding sermonId', code),
    baseSermonRevisionId: revision(
      raw.baseSermonRevisionId,
      'Extraction binding baseSermonRevisionId',
      code
    ),
    sourceId: identifier(raw.sourceId, 'Extraction binding sourceId', code),
    sourceSha256: revision(raw.sourceSha256, 'Extraction binding sourceSha256', code),
    sourceKind: sourceKind(raw.sourceKind, 'Extraction binding sourceKind', code),
    extractorId: extractorId(raw.extractorId, 'Extraction binding extractorId', code),
    extractorVersion: extractorVersion(
      raw.extractorVersion,
      'Extraction binding extractorVersion',
      code
    )
  });
}

function bindingForExtraction(sermonId, baseSermonRevisionId, extraction) {
  return normalizeBinding({
    sermonId,
    baseSermonRevisionId,
    sourceId: extraction.source.id,
    sourceSha256: extraction.source.sha256,
    sourceKind: extraction.source.kind,
    extractorId: extraction.extractor.id,
    extractorVersion: extraction.extractor.version
  });
}

function normalizeReadBindingRequest(raw) {
  exactKeys(raw, [
    'sermonId',
    'baseSermonRevisionId',
    'sourceId',
    'sourceSha256',
    'sourceKind',
    'extractorId',
    'extractorVersion'
  ], 'Exact extraction lookup');
  return normalizeBinding(raw);
}

function normalizeSnapshotRecord(raw) {
  exactKeys(
    raw,
    ['schemaVersion', 'kind', 'binding', 'extraction'],
    'Stored extraction snapshot',
    'SNAPSHOT_CORRUPT'
  );
  if (
    raw.schemaVersion !== EXTRACTION_SNAPSHOT_SCHEMA_VERSION
    || raw.kind !== EXTRACTION_SNAPSHOT_KIND
  ) {
    fail('SNAPSHOT_CORRUPT', 'The stored extraction snapshot uses an unsupported schema.');
  }
  const binding = normalizeBinding(raw.binding, 'SNAPSHOT_CORRUPT');
  let extraction;
  try {
    extraction = normalizeSermonSourceExtractionProposal(raw.extraction);
  } catch (_error) {
    fail('SNAPSHOT_CORRUPT', 'The stored extraction snapshot is invalid.');
  }
  const expectedBinding = bindingForExtraction(
    binding.sermonId,
    binding.baseSermonRevisionId,
    extraction
  );
  if (!canonicalEqual(binding, expectedBinding)) {
    fail('SNAPSHOT_CORRUPT', 'The stored extraction snapshot binding is inconsistent.');
  }
  return deepFreeze({
    schemaVersion: EXTRACTION_SNAPSHOT_SCHEMA_VERSION,
    kind: EXTRACTION_SNAPSHOT_KIND,
    binding,
    extraction
  });
}

function normalizeBindingIndex(raw) {
  exactKeys(
    raw,
    ['schemaVersion', 'kind', 'binding', 'snapshotHash'],
    'Stored extraction binding index',
    'BINDING_INDEX_CORRUPT'
  );
  if (
    raw.schemaVersion !== EXTRACTION_BINDING_INDEX_SCHEMA_VERSION
    || raw.kind !== EXTRACTION_BINDING_INDEX_KIND
  ) {
    fail(
      'BINDING_INDEX_CORRUPT',
      'The stored extraction binding index uses an unsupported schema.'
    );
  }
  return deepFreeze({
    schemaVersion: EXTRACTION_BINDING_INDEX_SCHEMA_VERSION,
    kind: EXTRACTION_BINDING_INDEX_KIND,
    binding: normalizeBinding(raw.binding, 'BINDING_INDEX_CORRUPT'),
    snapshotHash: revision(
      raw.snapshotHash,
      'Stored extraction binding snapshotHash',
      'BINDING_INDEX_CORRUPT'
    )
  });
}

function normalizeSelectedIds(value, prefix, field) {
  if (!Array.isArray(value) || value.length > MAX_SELECTED_SUGGESTIONS) {
    fail(
      'INVALID_REVIEW_RECEIPT',
      `${field} must contain at most ${MAX_SELECTED_SUGGESTIONS} suggestion IDs.`
    );
  }
  const seen = new Set();
  const normalized = value.map((candidate, index) => {
    if (typeof candidate !== 'string' || !candidate.startsWith(prefix)) {
      fail(
        'INVALID_REVIEW_RECEIPT',
        `${field} ${index + 1} does not use the required ${prefix} envelope.`
      );
    }
    const rawId = candidate.slice(prefix.length);
    identifier(rawId, `${field} ${index + 1}`, 'INVALID_REVIEW_RECEIPT');
    if (seen.has(candidate)) {
      fail('INVALID_REVIEW_RECEIPT', `${field} cannot repeat a suggestion ID.`);
    }
    seen.add(candidate);
    return candidate;
  });
  return normalized.sort();
}

function normalizeReviewReceiptRecord(raw) {
  exactKeys(raw, [
    'schemaVersion',
    'kind',
    'snapshotHash',
    'sermonId',
    'projectId',
    'resultingSermonRevisionId',
    'resultingProjectRevisionId',
    'reviewedAt',
    'outlineSuggestionIds',
    'referenceSuggestionIds'
  ], 'Stored extraction review receipt', 'REVIEW_RECEIPT_CORRUPT');
  if (
    raw.schemaVersion !== EXTRACTION_REVIEW_RECEIPT_SCHEMA_VERSION
    || raw.kind !== EXTRACTION_REVIEW_RECEIPT_KIND
  ) {
    fail(
      'REVIEW_RECEIPT_CORRUPT',
      'The stored extraction review receipt uses an unsupported schema.'
    );
  }
  const outlineSuggestionIds = normalizeSelectedIds(
    raw.outlineSuggestionIds,
    'outline:',
    'Outline suggestion IDs'
  );
  const referenceSuggestionIds = normalizeSelectedIds(
    raw.referenceSuggestionIds,
    'reference:',
    'Reference suggestion IDs'
  );
  if (outlineSuggestionIds.length + referenceSuggestionIds.length < 1) {
    fail('REVIEW_RECEIPT_CORRUPT', 'A stored review receipt has no selected suggestions.');
  }
  return deepFreeze({
    schemaVersion: EXTRACTION_REVIEW_RECEIPT_SCHEMA_VERSION,
    kind: EXTRACTION_REVIEW_RECEIPT_KIND,
    snapshotHash: revision(
      raw.snapshotHash,
      'Stored review receipt snapshotHash',
      'REVIEW_RECEIPT_CORRUPT'
    ),
    sermonId: identifier(
      raw.sermonId,
      'Stored review receipt sermonId',
      'REVIEW_RECEIPT_CORRUPT'
    ),
    projectId: identifier(
      raw.projectId,
      'Stored review receipt projectId',
      'REVIEW_RECEIPT_CORRUPT'
    ),
    resultingSermonRevisionId: revision(
      raw.resultingSermonRevisionId,
      'Stored review receipt resultingSermonRevisionId',
      'REVIEW_RECEIPT_CORRUPT'
    ),
    resultingProjectRevisionId: revision(
      raw.resultingProjectRevisionId,
      'Stored review receipt resultingProjectRevisionId',
      'REVIEW_RECEIPT_CORRUPT'
    ),
    reviewedAt: canonicalTimestamp(
      raw.reviewedAt,
      'Stored review receipt reviewedAt',
      'REVIEW_RECEIPT_CORRUPT'
    ),
    outlineSuggestionIds,
    referenceSuggestionIds
  });
}

function assertReceiptMatchesSnapshot(receipt, snapshot) {
  if (
    receipt.snapshotHash !== sha256(canonicalBuffer(snapshot))
    || receipt.sermonId !== snapshot.binding.sermonId
  ) {
    fail(
      'REVIEW_RECEIPT_CORRUPT',
      'The stored review receipt does not match its extraction snapshot.'
    );
  }
  const outlineIds = new Set(
    snapshot.extraction.outlineSuggestions.map(suggestion => `outline:${suggestion.id}`)
  );
  const referenceIds = new Set(
    snapshot.extraction.scriptureReferenceSuggestions
      .map(suggestion => `reference:${suggestion.id}`)
  );
  if (
    receipt.outlineSuggestionIds.some(id => !outlineIds.has(id))
    || receipt.referenceSuggestionIds.some(id => !referenceIds.has(id))
  ) {
    fail(
      'REVIEW_RECEIPT_CORRUPT',
      'The stored review receipt selects suggestions outside its extraction snapshot.'
    );
  }
}

function normalizeReviewLookup(raw, code = 'INVALID_REVIEW_LOOKUP') {
  exactKeys(raw, [
    'sermonId',
    'resultingSermonRevisionId',
    'sourceId',
    'sourceSha256',
    'projectId'
  ], 'Reviewed extraction lookup', code);
  return deepFreeze({
    sermonId: identifier(raw.sermonId, 'Reviewed extraction lookup sermonId', code),
    resultingSermonRevisionId: revision(
      raw.resultingSermonRevisionId,
      'Reviewed extraction lookup resultingSermonRevisionId',
      code
    ),
    sourceId: identifier(raw.sourceId, 'Reviewed extraction lookup sourceId', code),
    sourceSha256: revision(
      raw.sourceSha256,
      'Reviewed extraction lookup sourceSha256',
      code
    ),
    projectId: identifier(raw.projectId, 'Reviewed extraction lookup projectId', code)
  });
}

function reviewLookupFor(snapshot, receipt) {
  return normalizeReviewLookup({
    sermonId: snapshot.binding.sermonId,
    resultingSermonRevisionId: receipt.resultingSermonRevisionId,
    sourceId: snapshot.binding.sourceId,
    sourceSha256: snapshot.binding.sourceSha256,
    projectId: receipt.projectId
  });
}

function normalizeReviewIndex(raw) {
  exactKeys(
    raw,
    ['schemaVersion', 'kind', 'lookup', 'receipts'],
    'Stored reviewed extraction index',
    'REVIEW_INDEX_CORRUPT'
  );
  if (
    raw.schemaVersion !== EXTRACTION_REVIEW_INDEX_SCHEMA_VERSION
    || raw.kind !== EXTRACTION_REVIEW_INDEX_KIND
  ) {
    fail(
      'REVIEW_INDEX_CORRUPT',
      'The stored reviewed extraction index uses an unsupported schema.'
    );
  }
  if (
    !Array.isArray(raw.receipts)
    || raw.receipts.length < 1
    || raw.receipts.length > MAX_REVIEW_INDEX_ENTRIES
  ) {
    fail('REVIEW_INDEX_CORRUPT', 'The stored reviewed extraction index is outside its limit.');
  }
  const seen = new Set();
  const receipts = raw.receipts.map((entry, index) => {
    exactKeys(
      entry,
      ['snapshotHash', 'receiptHash'],
      `Stored reviewed extraction index receipt ${index + 1}`,
      'REVIEW_INDEX_CORRUPT'
    );
    const normalized = {
      snapshotHash: revision(
        entry.snapshotHash,
        'Stored reviewed extraction index snapshotHash',
        'REVIEW_INDEX_CORRUPT'
      ),
      receiptHash: revision(
        entry.receiptHash,
        'Stored reviewed extraction index receiptHash',
        'REVIEW_INDEX_CORRUPT'
      )
    };
    const key = `${normalized.snapshotHash}:${normalized.receiptHash}`;
    if (seen.has(key)) {
      fail('REVIEW_INDEX_CORRUPT', 'The stored reviewed extraction index repeats a receipt.');
    }
    seen.add(key);
    return normalized;
  }).sort((left, right) => (
    left.receiptHash.localeCompare(right.receiptHash)
    || left.snapshotHash.localeCompare(right.snapshotHash)
  ));
  return deepFreeze({
    schemaVersion: EXTRACTION_REVIEW_INDEX_SCHEMA_VERSION,
    kind: EXTRACTION_REVIEW_INDEX_KIND,
    lookup: normalizeReviewLookup(raw.lookup, 'REVIEW_INDEX_CORRUPT'),
    receipts
  });
}

function publicSnapshot(snapshotHash, snapshot) {
  return deepFreeze({
    snapshotHash,
    binding: snapshot.binding,
    extraction: snapshot.extraction
  });
}

function publicReceipt(receiptHash, receipt) {
  return deepFreeze({ receiptHash, ...receipt });
}

async function ensureOwnerOnlyDirectory(rootPath, directoryPath) {
  const root = await ensurePrivateDirectory(rootPath);
  const target = await ensureConfinedDirectory(root, directoryPath);
  if (process.platform !== 'win32') {
    const relative = path.relative(root, target);
    let current = root;
    for (const component of relative ? relative.split(path.sep) : []) {
      current = path.join(current, component);
      const stats = await fs.lstat(current);
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw new Error('An extraction storage directory is unsafe.');
      }
      if ((stats.mode & 0o077) !== 0) await fs.chmod(current, 0o700);
    }
  }
  return target;
}

class LocalSermonExtractionStore {
  constructor(options = {}) {
    if (typeof options.rootPath !== 'string' || !path.isAbsolute(options.rootPath)) {
      throw new TypeError('LocalSermonExtractionStore requires an absolute rootPath');
    }
    this.rootPath = path.resolve(options.rootPath);
    this.maximumSnapshots = capacityOption(
      options.maximumSnapshots,
      MAX_EXTRACTION_SNAPSHOTS,
      MAX_EXTRACTION_SNAPSHOTS,
      'maximumSnapshots'
    );
    this.maximumReviewReceipts = capacityOption(
      options.maximumReviewReceipts,
      MAX_EXTRACTION_REVIEW_RECEIPTS,
      MAX_EXTRACTION_REVIEW_RECEIPTS,
      'maximumReviewReceipts'
    );
    this.maximumReviewReceiptsPerSnapshot = capacityOption(
      options.maximumReviewReceiptsPerSnapshot,
      MAX_REVIEW_RECEIPTS_PER_SNAPSHOT,
      MAX_REVIEW_RECEIPTS_PER_SNAPSHOT,
      'maximumReviewReceiptsPerSnapshot'
    );
  }

  async initialize() {
    try {
      this.rootPath = await ensurePrivateDirectory(this.rootPath);
      for (const name of ['snapshots', 'bindings', 'receipts', 'review-index']) {
        await ensureOwnerOnlyDirectory(this.rootPath, path.join(this.rootPath, name));
      }
    } catch (error) {
      if (error instanceof LocalSermonExtractionStoreError) throw error;
      fail('STORE_UNAVAILABLE', 'The local sermon extraction store is unavailable.');
    }
    return this;
  }

  _snapshotPath(snapshotHash) {
    return path.join(
      this.rootPath,
      'snapshots',
      snapshotHash.slice(0, 2),
      `${snapshotHash}.json`
    );
  }

  _bindingIndexPath(binding) {
    const bindingHash = sha256(canonicalBuffer(binding));
    return path.join(
      this.rootPath,
      'bindings',
      bindingHash.slice(0, 2),
      `${bindingHash}.json`
    );
  }

  _receiptDirectory(snapshotHash) {
    return path.join(
      this.rootPath,
      'receipts',
      snapshotHash.slice(0, 2),
      snapshotHash
    );
  }

  _receiptPath(snapshotHash, receiptHash) {
    return path.join(this._receiptDirectory(snapshotHash), `${receiptHash}.json`);
  }

  _reviewIndexPath(lookup) {
    const lookupHash = sha256(canonicalBuffer(lookup));
    return path.join(
      this.rootPath,
      'review-index',
      lookupHash.slice(0, 2),
      `${lookupHash}.json`
    );
  }

  async _readCanonicalRecord(
    filePath,
    maximumBytes,
    normalize,
    { missingCode, corruptCode, missingMessage, corruptMessage }
  ) {
    let buffer;
    let stats;
    try {
      ({ buffer, stats } = await readFileNoFollow(filePath, maximumBytes));
    } catch (error) {
      if (error.code === 'ENOENT') fail(missingCode, missingMessage);
      fail(corruptCode, corruptMessage);
    }
    if (process.platform !== 'win32' && (stats.mode & 0o077) !== 0) {
      fail(corruptCode, corruptMessage);
    }
    let parsed;
    try {
      parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer));
    } catch (_error) {
      fail(corruptCode, corruptMessage);
    }
    let normalized;
    try {
      normalized = normalize(parsed);
    } catch (_error) {
      fail(corruptCode, corruptMessage);
    }
    if (!buffer.equals(canonicalBuffer(normalized))) fail(corruptCode, corruptMessage);
    return { buffer, normalized };
  }

  async _readSnapshot(snapshotHash) {
    revision(snapshotHash, 'Extraction snapshot hash', 'INVALID_SNAPSHOT_HASH');
    const snapshotPath = this._snapshotPath(snapshotHash);
    try {
      await ensureOwnerOnlyDirectory(this.rootPath, path.dirname(snapshotPath));
    } catch (_error) {
      fail('SNAPSHOT_CORRUPT', 'The stored extraction snapshot is unsafe.');
    }
    const { buffer, normalized } = await this._readCanonicalRecord(
      snapshotPath,
      MAX_EXTRACTION_SNAPSHOT_BYTES,
      normalizeSnapshotRecord,
      {
        missingCode: 'SNAPSHOT_NOT_FOUND',
        corruptCode: 'SNAPSHOT_CORRUPT',
        missingMessage: 'The requested extraction snapshot is unavailable.',
        corruptMessage: 'The stored extraction snapshot failed its integrity check.'
      }
    );
    if (sha256(buffer) !== snapshotHash) {
      fail('SNAPSHOT_CORRUPT', 'The stored extraction snapshot failed its integrity check.');
    }
    return normalized;
  }

  async _readBindingIndex(binding, { missingIsNull = false } = {}) {
    const indexPath = this._bindingIndexPath(binding);
    try {
      await ensureOwnerOnlyDirectory(this.rootPath, path.dirname(indexPath));
    } catch (_error) {
      fail('BINDING_INDEX_CORRUPT', 'The extraction binding index is unsafe.');
    }
    let result;
    try {
      result = await this._readCanonicalRecord(
        indexPath,
        MAX_EXTRACTION_BINDING_INDEX_BYTES,
        normalizeBindingIndex,
        {
          missingCode: 'BINDING_INDEX_NOT_FOUND',
          corruptCode: 'BINDING_INDEX_CORRUPT',
          missingMessage: 'No saved extraction matches that exact binding.',
          corruptMessage: 'The saved extraction binding index failed validation.'
        }
      );
    } catch (error) {
      if (
        missingIsNull
        && error instanceof LocalSermonExtractionStoreError
        && error.code === 'BINDING_INDEX_NOT_FOUND'
      ) {
        return null;
      }
      throw error;
    }
    const index = result.normalized;
    if (!canonicalEqual(index.binding, binding)) {
      fail('BINDING_INDEX_CORRUPT', 'The saved extraction binding index is inconsistent.');
    }
    return index;
  }

  async _readReceipt(receiptHash, expectedSnapshotHash = null) {
    revision(receiptHash, 'Extraction review receipt hash', 'INVALID_REVIEW_RECEIPT_HASH');
    if (expectedSnapshotHash !== null) {
      revision(expectedSnapshotHash, 'Extraction snapshot hash', 'INVALID_SNAPSHOT_HASH');
    }
    if (expectedSnapshotHash === null) {
      fail(
        'INVALID_REVIEW_RECEIPT_HASH',
        'Reading an extraction review receipt requires its snapshot hash.'
      );
    }
    const receiptPath = this._receiptPath(expectedSnapshotHash, receiptHash);
    try {
      await ensureOwnerOnlyDirectory(this.rootPath, path.dirname(receiptPath));
    } catch (_error) {
      fail('REVIEW_RECEIPT_CORRUPT', 'The stored extraction review receipt is unsafe.');
    }
    const { buffer, normalized } = await this._readCanonicalRecord(
      receiptPath,
      MAX_EXTRACTION_REVIEW_RECEIPT_BYTES,
      normalizeReviewReceiptRecord,
      {
        missingCode: 'REVIEW_RECEIPT_NOT_FOUND',
        corruptCode: 'REVIEW_RECEIPT_CORRUPT',
        missingMessage: 'The requested extraction review receipt is unavailable.',
        corruptMessage: 'The stored extraction review receipt failed validation.'
      }
    );
    if (
      sha256(buffer) !== receiptHash
      || normalized.snapshotHash !== expectedSnapshotHash
    ) {
      fail(
        'REVIEW_RECEIPT_CORRUPT',
        'The stored extraction review receipt failed its integrity check.'
      );
    }
    return normalized;
  }

  async _readReviewIndex(lookup, { missingIsNull = false } = {}) {
    const indexPath = this._reviewIndexPath(lookup);
    try {
      await ensureOwnerOnlyDirectory(this.rootPath, path.dirname(indexPath));
    } catch (_error) {
      fail('REVIEW_INDEX_CORRUPT', 'The reviewed extraction index is unsafe.');
    }
    let result;
    try {
      result = await this._readCanonicalRecord(
        indexPath,
        MAX_EXTRACTION_REVIEW_INDEX_BYTES,
        normalizeReviewIndex,
        {
          missingCode: 'REVIEW_INDEX_NOT_FOUND',
          corruptCode: 'REVIEW_INDEX_CORRUPT',
          missingMessage: 'No reviewed extraction matches that exact lookup.',
          corruptMessage: 'The reviewed extraction index failed validation.'
        }
      );
    } catch (error) {
      if (
        missingIsNull
        && error instanceof LocalSermonExtractionStoreError
        && error.code === 'REVIEW_INDEX_NOT_FOUND'
      ) {
        return null;
      }
      throw error;
    }
    if (!canonicalEqual(result.normalized.lookup, lookup)) {
      fail('REVIEW_INDEX_CORRUPT', 'The reviewed extraction index is inconsistent.');
    }
    return result.normalized;
  }

  async _storeImmutable(filePath, bytes, expectedHash, maximumBytes, corruptCode, label) {
    try {
      const { buffer } = await readFileNoFollow(filePath, maximumBytes);
      if (!buffer.equals(bytes) || sha256(buffer) !== expectedHash) {
        fail(corruptCode, `An immutable ${label} has changed.`);
      }
      return true;
    } catch (error) {
      if (error instanceof LocalSermonExtractionStoreError) throw error;
      if (error.code !== 'ENOENT') fail(corruptCode, `An immutable ${label} is unsafe.`);
    }
    try {
      await atomicWriteFile(filePath, bytes, {
        rootPath: this.rootPath,
        maximumBytes,
        mode: 0o600
      });
      const { buffer } = await readFileNoFollow(filePath, maximumBytes);
      if (!buffer.equals(bytes) || sha256(buffer) !== expectedHash) {
        fail(corruptCode, `The saved ${label} failed its integrity check.`);
      }
    } catch (error) {
      if (error instanceof LocalSermonExtractionStoreError) throw error;
      fail(corruptCode, `The ${label} could not be saved safely.`);
    }
    return false;
  }

  async _countSnapshotFiles(stopAfter) {
    let count = 0;
    const root = path.join(this.rootPath, 'snapshots');
    const prefixes = await fs.readdir(root, { withFileTypes: true });
    for (const prefix of prefixes) {
      if (!HASH_PREFIX_PATTERN.test(prefix.name)) continue;
      if (!prefix.isDirectory() || prefix.isSymbolicLink?.()) {
        fail('STORE_UNAVAILABLE', 'The extraction snapshot store is unsafe.');
      }
      const directory = path.join(root, prefix.name);
      await ensureOwnerOnlyDirectory(this.rootPath, directory);
      const entries = await fs.readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        if (!HASH_FILE_PATTERN.test(entry.name)) continue;
        count += 1;
        if (count >= stopAfter) return count;
      }
    }
    return count;
  }

  async _countReceiptFiles(stopAfter) {
    let count = 0;
    const root = path.join(this.rootPath, 'receipts');
    const prefixes = await fs.readdir(root, { withFileTypes: true });
    for (const prefix of prefixes) {
      if (!HASH_PREFIX_PATTERN.test(prefix.name)) continue;
      if (!prefix.isDirectory() || prefix.isSymbolicLink?.()) {
        fail('STORE_UNAVAILABLE', 'The extraction review receipt store is unsafe.');
      }
      const prefixPath = path.join(root, prefix.name);
      await ensureOwnerOnlyDirectory(this.rootPath, prefixPath);
      const snapshotDirectories = await fs.readdir(prefixPath, { withFileTypes: true });
      for (const snapshotDirectory of snapshotDirectories) {
        if (!HASH_DIRECTORY_PATTERN.test(snapshotDirectory.name)) continue;
        if (!snapshotDirectory.isDirectory() || snapshotDirectory.isSymbolicLink?.()) {
          fail('STORE_UNAVAILABLE', 'The extraction review receipt store is unsafe.');
        }
        const directory = path.join(prefixPath, snapshotDirectory.name);
        await ensureOwnerOnlyDirectory(this.rootPath, directory);
        const entries = await fs.readdir(directory, { withFileTypes: true });
        for (const entry of entries) {
          if (!HASH_FILE_PATTERN.test(entry.name)) continue;
          count += 1;
          if (count >= stopAfter) return count;
        }
      }
    }
    return count;
  }

  async _countReceiptFilesForSnapshot(snapshotHash, stopAfter) {
    revision(snapshotHash, 'Extraction snapshot hash', 'INVALID_SNAPSHOT_HASH');
    const directory = this._receiptDirectory(snapshotHash);
    await ensureOwnerOnlyDirectory(this.rootPath, directory);
    const entries = await fs.readdir(directory, { withFileTypes: true });
    let count = 0;
    for (const entry of entries) {
      if (!HASH_FILE_PATTERN.test(entry.name)) continue;
      count += 1;
      if (count >= stopAfter) return count;
    }
    return count;
  }

  async _scanReviewReferences(lookup) {
    const references = [];
    let receiptCount = 0;
    const root = path.join(this.rootPath, 'receipts');
    const prefixes = await fs.readdir(root, { withFileTypes: true });
    for (const prefix of prefixes) {
      if (!HASH_PREFIX_PATTERN.test(prefix.name)) continue;
      if (!prefix.isDirectory() || prefix.isSymbolicLink?.()) {
        fail('STORE_UNAVAILABLE', 'The extraction review receipt store is unsafe.');
      }
      const prefixPath = path.join(root, prefix.name);
      await ensureOwnerOnlyDirectory(this.rootPath, prefixPath);
      const snapshotDirectories = await fs.readdir(prefixPath, { withFileTypes: true });
      for (const snapshotDirectory of snapshotDirectories) {
        if (
          !HASH_DIRECTORY_PATTERN.test(snapshotDirectory.name)
          || snapshotDirectory.name.slice(0, 2) !== prefix.name
        ) {
          continue;
        }
        if (!snapshotDirectory.isDirectory() || snapshotDirectory.isSymbolicLink?.()) {
          fail('STORE_UNAVAILABLE', 'The extraction review receipt store is unsafe.');
        }
        const snapshotHash = snapshotDirectory.name;
        const directory = path.join(prefixPath, snapshotHash);
        await ensureOwnerOnlyDirectory(this.rootPath, directory);
        const entries = await fs.readdir(directory, { withFileTypes: true });
        // Receipt files for one snapshot are adjacent, so retain at most this
        // directory's parsed snapshot. Keeping a store-wide cache could retain
        // up to the full review-index limit of large extraction snapshots.
        let snapshot = null;
        let snapshotRead = false;
        for (const entry of entries) {
          const match = HASH_FILE_PATTERN.exec(entry.name);
          if (!match) continue;
          receiptCount += 1;
          if (receiptCount > MAX_EXTRACTION_REVIEW_RECEIPTS) {
            fail(
              'REVIEW_RECEIPT_CAPACITY_REACHED',
              'The local extraction review receipt capacity has been exceeded.'
            );
          }
          if (!entry.isFile() || entry.isSymbolicLink?.()) continue;

          let receipt;
          try {
            receipt = await this._readReceipt(match[1], snapshotHash);
          } catch (_error) {
            continue;
          }
          if (
            receipt.sermonId !== lookup.sermonId
            || receipt.projectId !== lookup.projectId
            || receipt.resultingSermonRevisionId !== lookup.resultingSermonRevisionId
          ) {
            continue;
          }

          if (!snapshotRead) {
            snapshotRead = true;
            try {
              snapshot = await this._readSnapshot(snapshotHash);
            } catch (_error) {
              snapshot = null;
            }
          }
          if (!snapshot) continue;
          try {
            assertReceiptMatchesSnapshot(receipt, snapshot);
          } catch (_error) {
            continue;
          }
          if (!canonicalEqual(reviewLookupFor(snapshot, receipt), lookup)) continue;
          references.push({
            snapshotHash,
            receiptHash: match[1]
          });
          if (references.length > MAX_REVIEW_INDEX_ENTRIES) {
            fail(
              'REVIEW_INDEX_CAPACITY_REACHED',
              'That exact reviewed extraction lookup has reached its receipt limit.'
            );
          }
        }
      }
    }
    return references;
  }

  async _reviewIndexFromDurableReceipts(lookup) {
    const references = await this._scanReviewReferences(lookup);
    if (references.length === 0) return null;
    return normalizeReviewIndex({
      schemaVersion: EXTRACTION_REVIEW_INDEX_SCHEMA_VERSION,
      kind: EXTRACTION_REVIEW_INDEX_KIND,
      lookup,
      receipts: references
    });
  }

  _mergeReviewIndexes(lookup, existing, recovered) {
    if (!existing) return recovered;
    if (!recovered) return existing;
    const receipts = [...existing.receipts];
    const seen = new Set(receipts.map(reference =>
      `${reference.snapshotHash}:${reference.receiptHash}`));
    for (const reference of recovered.receipts) {
      const key = `${reference.snapshotHash}:${reference.receiptHash}`;
      if (seen.has(key)) continue;
      if (receipts.length >= MAX_REVIEW_INDEX_ENTRIES) {
        fail(
          'REVIEW_INDEX_CAPACITY_REACHED',
          'That exact reviewed extraction lookup has reached its receipt limit.'
        );
      }
      seen.add(key);
      receipts.push(reference);
    }
    return normalizeReviewIndex({
      schemaVersion: EXTRACTION_REVIEW_INDEX_SCHEMA_VERSION,
      kind: EXTRACTION_REVIEW_INDEX_KIND,
      lookup,
      receipts
    });
  }

  async _reconcileReviewIndex(lookup, observedIndex) {
    try {
      return await withExclusiveFileLock(
        path.join(this.rootPath, '.extraction-write-lock'),
        async () => {
          const existing = await this._readReviewIndex(lookup, {
            missingIsNull: true
          });
          const recovered = await this._reviewIndexFromDurableReceipts(lookup);
          const reconciled = this._mergeReviewIndexes(lookup, existing, recovered);
          if (!reconciled) return null;
          if (existing && canonicalEqual(existing, reconciled)) return existing;
          const indexPath = this._reviewIndexPath(lookup);
          await ensureOwnerOnlyDirectory(this.rootPath, path.dirname(indexPath));
          await atomicWriteFile(indexPath, canonicalBuffer(reconciled), {
            rootPath: this.rootPath,
            maximumBytes: MAX_EXTRACTION_REVIEW_INDEX_BYTES,
            mode: 0o600
          });
          return this._readReviewIndex(lookup);
        }
      );
    } catch (error) {
      if (error instanceof LocalSermonExtractionStoreError) throw error;
      if (error.code === 'WRITE_LOCKED') {
        // A process can stop after publishing the immutable receipt but before
        // publishing or updating its lookup index or releasing the lock. The
        // durable records remain safe to validate read-only during that
        // stale-lock window; a later unlocked lookup will publish the
        // reconciled index.
        try {
          const recovered = await this._reviewIndexFromDurableReceipts(lookup);
          return this._mergeReviewIndexes(lookup, observedIndex, recovered);
        } catch (scanError) {
          if (scanError instanceof LocalSermonExtractionStoreError) throw scanError;
          fail(
            'STORE_UNAVAILABLE',
            'The reviewed sermon extraction index could not be reconciled.'
          );
        }
      }
      fail('STORE_UNAVAILABLE', 'The reviewed sermon extraction index could not be reconciled.');
    }
  }

  async readExactSnapshot(rawBinding) {
    await this.initialize();
    const binding = normalizeReadBindingRequest(rawBinding);
    const index = await this._readBindingIndex(binding, { missingIsNull: true });
    if (!index) return null;
    const snapshot = await this._readSnapshot(index.snapshotHash);
    if (!canonicalEqual(snapshot.binding, binding)) {
      fail('BINDING_INDEX_CORRUPT', 'The saved extraction binding index points elsewhere.');
    }
    return publicSnapshot(index.snapshotHash, snapshot);
  }

  async saveSnapshot(raw = {}) {
    exactKeys(
      raw,
      ['sermonId', 'baseSermonRevisionId', 'extraction'],
      'Extraction snapshot save request'
    );
    const sermonId = identifier(raw.sermonId, 'Extraction snapshot sermonId');
    const baseSermonRevisionId = revision(
      raw.baseSermonRevisionId,
      'Extraction snapshot baseSermonRevisionId'
    );
    let extraction;
    try {
      extraction = normalizeSermonSourceExtractionProposal(raw.extraction);
    } catch (error) {
      fail(
        error?.code === 'EXTRACTION_PROPOSAL_TOO_LARGE'
          ? 'SNAPSHOT_TOO_LARGE'
          : 'INVALID_EXTRACTION_SNAPSHOT',
        'The sermon source extraction is not safe to persist.'
      );
    }
    const binding = bindingForExtraction(sermonId, baseSermonRevisionId, extraction);
    const snapshot = normalizeSnapshotRecord({
      schemaVersion: EXTRACTION_SNAPSHOT_SCHEMA_VERSION,
      kind: EXTRACTION_SNAPSHOT_KIND,
      binding,
      extraction
    });
    const snapshotBytes = canonicalBuffer(snapshot);
    if (snapshotBytes.length > MAX_EXTRACTION_SNAPSHOT_BYTES) {
      fail('SNAPSHOT_TOO_LARGE', 'The sermon source extraction exceeds the storage limit.');
    }
    const snapshotHash = sha256(snapshotBytes);

    await this.initialize();
    try {
      return await withExclusiveFileLock(
        path.join(this.rootPath, '.extraction-write-lock'),
        async () => {
          const existingIndex = await this._readBindingIndex(binding, {
            missingIsNull: true
          });
          if (existingIndex) {
            const existingSnapshot = await this._readSnapshot(existingIndex.snapshotHash);
            if (!canonicalEqual(existingSnapshot.binding, binding)) {
              fail(
                'BINDING_INDEX_CORRUPT',
                'The saved extraction binding index points elsewhere.'
              );
            }
            if (existingIndex.snapshotHash !== snapshotHash) {
              fail(
                'BINDING_CONFLICT',
                'The same exact source and extractor binding produced different evidence.',
                {
                  existingSnapshotHash: existingIndex.snapshotHash,
                  proposedSnapshotHash: snapshotHash
                }
              );
            }
            if (!canonicalEqual(existingSnapshot, snapshot)) {
              fail('SNAPSHOT_CORRUPT', 'The immutable extraction snapshot is inconsistent.');
            }
            return deepFreeze({
              ...publicSnapshot(snapshotHash, existingSnapshot),
              unchanged: true
            });
          }

          let snapshotAlreadyStored = false;
          try {
            const orphanedSnapshot = await this._readSnapshot(snapshotHash);
            if (!canonicalEqual(orphanedSnapshot, snapshot)) {
              fail('SNAPSHOT_CORRUPT', 'The immutable extraction snapshot is inconsistent.');
            }
            snapshotAlreadyStored = true;
          } catch (error) {
            if (
              !(error instanceof LocalSermonExtractionStoreError)
              || error.code !== 'SNAPSHOT_NOT_FOUND'
            ) {
              throw error;
            }
          }
          if (
            !snapshotAlreadyStored
            && await this._countSnapshotFiles(this.maximumSnapshots) >= this.maximumSnapshots
          ) {
            fail(
              'SNAPSHOT_CAPACITY_REACHED',
              `The local extraction store can contain at most ${this.maximumSnapshots} snapshots.`
            );
          }
          const snapshotPath = this._snapshotPath(snapshotHash);
          await ensureOwnerOnlyDirectory(this.rootPath, path.dirname(snapshotPath));
          await this._storeImmutable(
            snapshotPath,
            snapshotBytes,
            snapshotHash,
            MAX_EXTRACTION_SNAPSHOT_BYTES,
            'SNAPSHOT_CORRUPT',
            'extraction snapshot'
          );

          const index = normalizeBindingIndex({
            schemaVersion: EXTRACTION_BINDING_INDEX_SCHEMA_VERSION,
            kind: EXTRACTION_BINDING_INDEX_KIND,
            binding,
            snapshotHash
          });
          const indexPath = this._bindingIndexPath(binding);
          await ensureOwnerOnlyDirectory(this.rootPath, path.dirname(indexPath));
          await atomicWriteFile(indexPath, canonicalBuffer(index), {
            rootPath: this.rootPath,
            maximumBytes: MAX_EXTRACTION_BINDING_INDEX_BYTES,
            mode: 0o600
          });
          const verifiedIndex = await this._readBindingIndex(binding);
          if (verifiedIndex.snapshotHash !== snapshotHash) {
            fail('BINDING_INDEX_CORRUPT', 'The saved extraction binding index is inconsistent.');
          }
          return deepFreeze({
            ...publicSnapshot(snapshotHash, snapshot),
            unchanged: false
          });
        }
      );
    } catch (error) {
      if (error instanceof LocalSermonExtractionStoreError) throw error;
      if (error.code === 'WRITE_LOCKED') {
        fail('WRITE_LOCKED', 'The local sermon extraction store is already being updated.');
      }
      fail('STORE_UNAVAILABLE', 'The sermon source extraction could not be saved.');
    }
  }

  async saveReviewReceipt(raw = {}) {
    exactKeys(raw, [
      'snapshotHash',
      'projectId',
      'resultingSermonRevisionId',
      'resultingProjectRevisionId',
      'reviewedAt',
      'outlineSuggestionIds',
      'referenceSuggestionIds'
    ], 'Extraction review receipt save request', 'INVALID_REVIEW_RECEIPT');
    const snapshotHash = revision(
      raw.snapshotHash,
      'Extraction review receipt snapshotHash',
      'INVALID_REVIEW_RECEIPT'
    );
    const projectId = identifier(
      raw.projectId,
      'Extraction review receipt projectId',
      'INVALID_REVIEW_RECEIPT'
    );
    const resultingSermonRevisionId = revision(
      raw.resultingSermonRevisionId,
      'Extraction review receipt resultingSermonRevisionId',
      'INVALID_REVIEW_RECEIPT'
    );
    const resultingProjectRevisionId = revision(
      raw.resultingProjectRevisionId,
      'Extraction review receipt resultingProjectRevisionId',
      'INVALID_REVIEW_RECEIPT'
    );
    const reviewedAt = canonicalTimestamp(
      raw.reviewedAt,
      'Extraction review receipt reviewedAt'
    );
    const outlineSuggestionIds = normalizeSelectedIds(
      raw.outlineSuggestionIds,
      'outline:',
      'Outline suggestion IDs'
    );
    const referenceSuggestionIds = normalizeSelectedIds(
      raw.referenceSuggestionIds,
      'reference:',
      'Reference suggestion IDs'
    );
    if (outlineSuggestionIds.length + referenceSuggestionIds.length < 1) {
      fail('INVALID_REVIEW_RECEIPT', 'A review receipt requires at least one selection.');
    }

    await this.initialize();
    const snapshot = await this._readSnapshot(snapshotHash);
    const receipt = normalizeReviewReceiptRecord({
      schemaVersion: EXTRACTION_REVIEW_RECEIPT_SCHEMA_VERSION,
      kind: EXTRACTION_REVIEW_RECEIPT_KIND,
      snapshotHash,
      sermonId: snapshot.binding.sermonId,
      projectId,
      resultingSermonRevisionId,
      resultingProjectRevisionId,
      reviewedAt,
      outlineSuggestionIds,
      referenceSuggestionIds
    });
    try {
      assertReceiptMatchesSnapshot(receipt, snapshot);
    } catch (_error) {
      fail(
        'UNKNOWN_REVIEW_SUGGESTION',
        'The review receipt selects a suggestion outside its extraction snapshot.'
      );
    }
    const receiptBytes = canonicalBuffer(receipt);
    if (receiptBytes.length > MAX_EXTRACTION_REVIEW_RECEIPT_BYTES) {
      fail('REVIEW_RECEIPT_TOO_LARGE', 'The extraction review receipt exceeds its limit.');
    }
    const receiptHash = sha256(receiptBytes);
    const lookup = reviewLookupFor(snapshot, receipt);

    try {
      return await withExclusiveFileLock(
        path.join(this.rootPath, '.extraction-write-lock'),
        async () => {
          const receiptPath = this._receiptPath(snapshotHash, receiptHash);
          await ensureOwnerOnlyDirectory(this.rootPath, path.dirname(receiptPath));
          let existed = false;
          try {
            const existing = await this._readReceipt(receiptHash, snapshotHash);
            assertReceiptMatchesSnapshot(existing, snapshot);
            if (!canonicalEqual(existing, receipt)) {
              fail(
                'REVIEW_RECEIPT_CORRUPT',
                'An immutable extraction review receipt is inconsistent.'
              );
            }
            existed = true;
          } catch (error) {
            if (
              !(error instanceof LocalSermonExtractionStoreError)
              || error.code !== 'REVIEW_RECEIPT_NOT_FOUND'
            ) {
              throw error;
            }
          }

          const currentIndex = await this._readReviewIndex(lookup, {
            missingIsNull: true
          });
          const entry = { snapshotHash, receiptHash };
          const entries = currentIndex
            ? [...currentIndex.receipts]
            : [];
          const alreadyIndexed = entries.some(candidate =>
            candidate.snapshotHash === snapshotHash
            && candidate.receiptHash === receiptHash);
          if (!alreadyIndexed && entries.length >= MAX_REVIEW_INDEX_ENTRIES) {
            fail(
              'REVIEW_INDEX_CAPACITY_REACHED',
              'That exact reviewed extraction lookup has reached its receipt limit.'
            );
          }

          if (!existed) {
            if (
              await this._countReceiptFilesForSnapshot(
                snapshotHash,
                this.maximumReviewReceiptsPerSnapshot
              ) >= this.maximumReviewReceiptsPerSnapshot
            ) {
              fail(
                'REVIEW_RECEIPT_SNAPSHOT_CAPACITY_REACHED',
                'That extraction snapshot has reached its review receipt limit.'
              );
            }
            if (
              await this._countReceiptFiles(this.maximumReviewReceipts)
              >= this.maximumReviewReceipts
            ) {
              fail(
                'REVIEW_RECEIPT_CAPACITY_REACHED',
                'The local extraction review receipt capacity has been reached.'
              );
            }
            await this._storeImmutable(
              receiptPath,
              receiptBytes,
              receiptHash,
              MAX_EXTRACTION_REVIEW_RECEIPT_BYTES,
              'REVIEW_RECEIPT_CORRUPT',
              'extraction review receipt'
            );
          }

          if (!alreadyIndexed) entries.push(entry);
          const nextIndex = normalizeReviewIndex({
            schemaVersion: EXTRACTION_REVIEW_INDEX_SCHEMA_VERSION,
            kind: EXTRACTION_REVIEW_INDEX_KIND,
            lookup,
            receipts: entries
          });
          const indexPath = this._reviewIndexPath(lookup);
          await ensureOwnerOnlyDirectory(this.rootPath, path.dirname(indexPath));
          if (!currentIndex || !canonicalEqual(currentIndex, nextIndex)) {
            await atomicWriteFile(indexPath, canonicalBuffer(nextIndex), {
              rootPath: this.rootPath,
              maximumBytes: MAX_EXTRACTION_REVIEW_INDEX_BYTES,
              mode: 0o600
            });
          }
          await this._readReviewIndex(lookup);
          return deepFreeze({
            receiptHash,
            receipt,
            unchanged: existed
          });
        }
      );
    } catch (error) {
      if (error instanceof LocalSermonExtractionStoreError) throw error;
      if (error.code === 'WRITE_LOCKED') {
        fail('WRITE_LOCKED', 'The local sermon extraction store is already being updated.');
      }
      fail('STORE_UNAVAILABLE', 'The extraction review receipt could not be saved.');
    }
  }

  async readReviewStatus(raw = {}) {
    exactKeys(
      raw,
      Object.prototype.hasOwnProperty.call(raw, 'projectId')
        ? ['snapshotHash', 'projectId']
        : ['snapshotHash'],
      'Extraction review status request',
      'INVALID_REVIEW_LOOKUP'
    );
    const snapshotHash = revision(
      raw.snapshotHash,
      'Extraction review status snapshotHash',
      'INVALID_REVIEW_LOOKUP'
    );
    const projectId = raw.projectId === undefined
      ? null
      : identifier(raw.projectId, 'Extraction review status projectId', 'INVALID_REVIEW_LOOKUP');
    await this.initialize();
    const snapshot = await this._readSnapshot(snapshotHash);
    const directory = this._receiptDirectory(snapshotHash);
    let stats;
    try {
      stats = await fs.lstat(directory);
    } catch (error) {
      if (error.code === 'ENOENT') {
        return deepFreeze({
          snapshotHash,
          reviewed: false,
          receipts: [],
          skippedCorruptReceipts: 0
        });
      }
      fail('REVIEW_RECEIPT_CORRUPT', 'The extraction review receipt directory is unsafe.');
    }
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      fail('REVIEW_RECEIPT_CORRUPT', 'The extraction review receipt directory is unsafe.');
    }
    try {
      await ensureOwnerOnlyDirectory(this.rootPath, directory);
    } catch (_error) {
      fail('REVIEW_RECEIPT_CORRUPT', 'The extraction review receipt directory is unsafe.');
    }
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (_error) {
      fail('REVIEW_RECEIPT_CORRUPT', 'The extraction review receipt directory is unsafe.');
    }
    const candidates = entries.filter(entry => HASH_FILE_PATTERN.test(entry.name));
    if (candidates.length > MAX_REVIEW_RECEIPTS_PER_SNAPSHOT) {
      fail(
        'REVIEW_STATUS_CAPACITY_EXCEEDED',
        'That extraction snapshot has too many review receipts to inspect safely.'
      );
    }
    const receipts = [];
    let skippedCorruptReceipts = 0;
    for (const entry of candidates) {
      const receiptHash = HASH_FILE_PATTERN.exec(entry.name)[1];
      try {
        if (!entry.isFile() || entry.isSymbolicLink?.()) {
          throw new Error('unsafe receipt');
        }
        const receipt = await this._readReceipt(receiptHash, snapshotHash);
        assertReceiptMatchesSnapshot(receipt, snapshot);
        if (projectId === null || receipt.projectId === projectId) {
          receipts.push(publicReceipt(receiptHash, receipt));
        }
      } catch (_error) {
        skippedCorruptReceipts += 1;
      }
    }
    receipts.sort((left, right) => (
      right.reviewedAt.localeCompare(left.reviewedAt)
      || left.receiptHash.localeCompare(right.receiptHash)
    ));
    return deepFreeze({
      snapshotHash,
      reviewed: receipts.length > 0,
      receipts,
      skippedCorruptReceipts
    });
  }

  async findReviewedSnapshot(rawLookup = {}) {
    await this.initialize();
    const lookup = normalizeReviewLookup(rawLookup);
    let index = await this._readReviewIndex(lookup, { missingIsNull: true });
    index = await this._reconcileReviewIndex(lookup, index);
    if (!index) return null;

    const candidates = [];
    let skippedCorruptReceipts = 0;
    for (const reference of index.receipts) {
      try {
        const snapshot = await this._readSnapshot(reference.snapshotHash);
        const receipt = await this._readReceipt(
          reference.receiptHash,
          reference.snapshotHash
        );
        assertReceiptMatchesSnapshot(receipt, snapshot);
        const actualLookup = reviewLookupFor(snapshot, receipt);
        if (!canonicalEqual(actualLookup, lookup)) {
          fail('REVIEW_INDEX_CORRUPT', 'The reviewed extraction index points elsewhere.');
        }
        candidates.push({
          snapshotHash: reference.snapshotHash,
          snapshot,
          receiptHash: reference.receiptHash,
          receipt
        });
      } catch (error) {
        if (
          error instanceof LocalSermonExtractionStoreError
          && error.code === 'REVIEW_INDEX_CORRUPT'
        ) {
          throw error;
        }
        skippedCorruptReceipts += 1;
      }
    }
    if (candidates.length === 0) {
      if (skippedCorruptReceipts > 0) {
        fail(
          'REVIEW_EVIDENCE_CORRUPT',
          'Saved reviewed extraction evidence exists but could not be validated.'
        );
      }
      return null;
    }
    candidates.sort((left, right) => (
      right.receipt.reviewedAt.localeCompare(left.receipt.reviewedAt)
      || left.receiptHash.localeCompare(right.receiptHash)
    ));
    const selected = candidates[0];
    const reviewStatus = await this.readReviewStatus({
      snapshotHash: selected.snapshotHash,
      projectId: lookup.projectId
    });
    return deepFreeze({
      snapshot: publicSnapshot(selected.snapshotHash, selected.snapshot),
      receipt: publicReceipt(selected.receiptHash, selected.receipt),
      reviewStatus: {
        ...reviewStatus,
        skippedCorruptReceipts: Math.max(
          reviewStatus.skippedCorruptReceipts,
          skippedCorruptReceipts
        )
      }
    });
  }

  async collectSourceObjectReferences(options = {}) {
    const maximumFiles = capacityOption(
      options.maximumFiles,
      MAX_REFERENCE_SCAN_FILES,
      MAX_REFERENCE_SCAN_FILES,
      'maximumFiles'
    );
    const maximumBytes = capacityOption(
      options.maximumBytes,
      MAX_REFERENCE_SCAN_BYTES,
      MAX_REFERENCE_SCAN_BYTES,
      'maximumBytes'
    );
    await this.initialize();
    return withExclusiveFileLock(
      path.join(this.rootPath, '.extraction-write-lock'),
      async () => {
        let rootEntries;
        try {
          rootEntries = await fs.readdir(this.rootPath, { withFileTypes: true });
        } catch (_error) {
          fail('REFERENCE_SCAN_INCOMPLETE', 'The extraction reference scan could not be completed.');
        }
        const expectedRoots = new Set(['snapshots', 'bindings', 'receipts', 'review-index']);
        for (const entry of rootEntries) {
          if (entry.name === '.extraction-write-lock') {
            if (!entry.isDirectory() || entry.isSymbolicLink?.()) {
              fail('REFERENCE_SCAN_AMBIGUOUS', 'The extraction store contains unsafe maintenance state.');
            }
            continue;
          }
          if (
            !expectedRoots.delete(entry.name)
            || !entry.isDirectory()
            || entry.isSymbolicLink?.()
          ) {
            fail('REFERENCE_SCAN_AMBIGUOUS', 'The extraction store contains an unsupported entry.');
          }
        }
        if (expectedRoots.size > 0) {
          fail('REFERENCE_SCAN_AMBIGUOUS', 'The extraction store inventory is incomplete.');
        }

        let filesScanned = 0;
        let bytesScanned = 0;
        const accountFile = async filePath => {
          let stats;
          try {
            stats = await fs.lstat(filePath);
          } catch (_error) {
            fail('REFERENCE_SCAN_INCOMPLETE', 'The extraction reference inventory changed during validation.');
          }
          if (!stats.isFile() || stats.isSymbolicLink()) {
            fail('REFERENCE_SCAN_AMBIGUOUS', 'The extraction store contains an unsafe reference file.');
          }
          if (
            filesScanned + 1 > maximumFiles
            || bytesScanned + stats.size > maximumBytes
          ) {
            fail('REFERENCE_SCAN_LIMIT', 'The extraction store exceeds the bounded reference scan.');
          }
          filesScanned += 1;
          bytesScanned += stats.size;
        };
        const readPrefixDirectories = async rootName => {
          const root = path.join(this.rootPath, rootName);
          let entries;
          try {
            entries = await fs.readdir(root, { withFileTypes: true });
          } catch (_error) {
            fail('REFERENCE_SCAN_INCOMPLETE', 'The extraction reference scan could not be completed.');
          }
          entries.sort((left, right) => left.name.localeCompare(right.name));
          for (const entry of entries) {
            if (
              !HASH_PREFIX_PATTERN.test(entry.name)
              || !entry.isDirectory()
              || entry.isSymbolicLink?.()
            ) {
              fail('REFERENCE_SCAN_AMBIGUOUS', 'The extraction store contains an unsupported hash directory.');
            }
          }
          return entries;
        };

        const digests = new Set();
        const snapshots = new Map();
        let snapshotCount = 0;
        for (const prefix of await readPrefixDirectories('snapshots')) {
          const prefixPath = path.join(this.rootPath, 'snapshots', prefix.name);
          const entries = await fs.readdir(prefixPath, { withFileTypes: true });
          if (entries.length > this.maximumSnapshots - snapshotCount) {
            fail('REFERENCE_SCAN_LIMIT', 'The extraction store exceeds the bounded snapshot scan.');
          }
          entries.sort((left, right) => left.name.localeCompare(right.name));
          for (const entry of entries) {
            const match = HASH_FILE_PATTERN.exec(entry.name);
            if (
              !match
              || match[1].slice(0, 2) !== prefix.name
              || !entry.isFile()
              || entry.isSymbolicLink?.()
            ) {
              fail('REFERENCE_SCAN_AMBIGUOUS', 'The extraction store contains an unsupported snapshot entry.');
            }
            snapshotCount += 1;
            if (snapshotCount > this.maximumSnapshots) {
              fail('REFERENCE_SCAN_LIMIT', 'The extraction store exceeds the bounded snapshot scan.');
            }
            await accountFile(path.join(prefixPath, entry.name));
            const snapshot = await this._readSnapshot(match[1]);
            snapshots.set(match[1], snapshot.binding);
            digests.add(snapshot.binding.sourceSha256);
          }
        }

        let bindingCount = 0;
        for (const prefix of await readPrefixDirectories('bindings')) {
          const prefixPath = path.join(this.rootPath, 'bindings', prefix.name);
          const entries = await fs.readdir(prefixPath, { withFileTypes: true });
          if (entries.length > maximumFiles - filesScanned) {
            fail('REFERENCE_SCAN_LIMIT', 'The extraction store exceeds the bounded reference scan.');
          }
          entries.sort((left, right) => left.name.localeCompare(right.name));
          for (const entry of entries) {
            const match = HASH_FILE_PATTERN.exec(entry.name);
            if (
              !match
              || match[1].slice(0, 2) !== prefix.name
              || !entry.isFile()
              || entry.isSymbolicLink?.()
            ) {
              fail('REFERENCE_SCAN_AMBIGUOUS', 'The extraction store contains an unsupported binding entry.');
            }
            const filePath = path.join(prefixPath, entry.name);
            await accountFile(filePath);
            const { normalized: index } = await this._readCanonicalRecord(
              filePath,
              MAX_EXTRACTION_BINDING_INDEX_BYTES,
              normalizeBindingIndex,
              {
                missingCode: 'BINDING_INDEX_NOT_FOUND',
                corruptCode: 'BINDING_INDEX_CORRUPT',
                missingMessage: 'A saved extraction binding is unavailable.',
                corruptMessage: 'A saved extraction binding failed validation.'
              }
            );
            const snapshotBinding = snapshots.get(index.snapshotHash);
            if (
              sha256(canonicalBuffer(index.binding)) !== match[1]
              || !snapshotBinding
              || !canonicalEqual(snapshotBinding, index.binding)
            ) {
              fail('REFERENCE_SCAN_CORRUPT', 'A saved extraction binding is inconsistent.');
            }
            bindingCount += 1;
            digests.add(index.binding.sourceSha256);
          }
        }

        const receiptLookups = new Map();
        let receiptCount = 0;
        for (const prefix of await readPrefixDirectories('receipts')) {
          const prefixPath = path.join(this.rootPath, 'receipts', prefix.name);
          const snapshotDirectories = await fs.readdir(prefixPath, { withFileTypes: true });
          if (snapshotDirectories.length > snapshots.size) {
            fail('REFERENCE_SCAN_LIMIT', 'The extraction store exceeds the bounded receipt scan.');
          }
          snapshotDirectories.sort((left, right) => left.name.localeCompare(right.name));
          for (const snapshotDirectory of snapshotDirectories) {
            const snapshotHash = snapshotDirectory.name;
            if (
              !HASH_DIRECTORY_PATTERN.test(snapshotHash)
              || snapshotHash.slice(0, 2) !== prefix.name
              || !snapshotDirectory.isDirectory()
              || snapshotDirectory.isSymbolicLink?.()
            ) {
              fail('REFERENCE_SCAN_AMBIGUOUS', 'The extraction store contains an unsupported receipt directory.');
            }
            if (!snapshots.has(snapshotHash)) {
              fail('REFERENCE_SCAN_CORRUPT', 'Extraction review receipts reference an unavailable snapshot.');
            }
            const snapshot = await this._readSnapshot(snapshotHash);
            const receiptDirectory = path.join(prefixPath, snapshotHash);
            const entries = await fs.readdir(receiptDirectory, { withFileTypes: true });
            entries.sort((left, right) => left.name.localeCompare(right.name));
            if (entries.length > this.maximumReviewReceiptsPerSnapshot) {
              fail('REFERENCE_SCAN_LIMIT', 'The extraction store exceeds the bounded receipt scan.');
            }
            for (const entry of entries) {
              const match = HASH_FILE_PATTERN.exec(entry.name);
              if (!match || !entry.isFile() || entry.isSymbolicLink?.()) {
                fail('REFERENCE_SCAN_AMBIGUOUS', 'The extraction store contains an unsupported receipt entry.');
              }
              receiptCount += 1;
              if (receiptCount > this.maximumReviewReceipts) {
                fail('REFERENCE_SCAN_LIMIT', 'The extraction store exceeds the bounded receipt scan.');
              }
              await accountFile(path.join(receiptDirectory, entry.name));
              const receipt = await this._readReceipt(match[1], snapshotHash);
              assertReceiptMatchesSnapshot(receipt, snapshot);
              receiptLookups.set(
                `${snapshotHash}:${match[1]}`,
                reviewLookupFor(snapshot, receipt)
              );
              digests.add(snapshot.binding.sourceSha256);
            }
          }
        }

        let reviewIndexCount = 0;
        for (const prefix of await readPrefixDirectories('review-index')) {
          const prefixPath = path.join(this.rootPath, 'review-index', prefix.name);
          const entries = await fs.readdir(prefixPath, { withFileTypes: true });
          if (entries.length > maximumFiles - filesScanned) {
            fail('REFERENCE_SCAN_LIMIT', 'The extraction store exceeds the bounded reference scan.');
          }
          entries.sort((left, right) => left.name.localeCompare(right.name));
          for (const entry of entries) {
            const match = HASH_FILE_PATTERN.exec(entry.name);
            if (
              !match
              || match[1].slice(0, 2) !== prefix.name
              || !entry.isFile()
              || entry.isSymbolicLink?.()
            ) {
              fail('REFERENCE_SCAN_AMBIGUOUS', 'The extraction store contains an unsupported review index entry.');
            }
            const filePath = path.join(prefixPath, entry.name);
            await accountFile(filePath);
            const { normalized: index } = await this._readCanonicalRecord(
              filePath,
              MAX_EXTRACTION_REVIEW_INDEX_BYTES,
              normalizeReviewIndex,
              {
                missingCode: 'REVIEW_INDEX_NOT_FOUND',
                corruptCode: 'REVIEW_INDEX_CORRUPT',
                missingMessage: 'A reviewed extraction index is unavailable.',
                corruptMessage: 'A reviewed extraction index failed validation.'
              }
            );
            if (sha256(canonicalBuffer(index.lookup)) !== match[1]) {
              fail('REFERENCE_SCAN_CORRUPT', 'A reviewed extraction index has an inconsistent identity.');
            }
            for (const reference of index.receipts) {
              const lookup = receiptLookups.get(
                `${reference.snapshotHash}:${reference.receiptHash}`
              );
              if (!lookup || !canonicalEqual(lookup, index.lookup)) {
                fail('REFERENCE_SCAN_CORRUPT', 'A reviewed extraction index references inconsistent evidence.');
              }
              digests.add(lookup.sourceSha256);
            }
            reviewIndexCount += 1;
          }
        }

        return deepFreeze({
          digests: [...digests].sort(),
          snapshotCount,
          bindingCount,
          receiptCount,
          reviewIndexCount,
          filesScanned,
          bytesScanned
        });
      }
    );
  }
}

module.exports = {
  EXTRACTION_BINDING_INDEX_KIND,
  EXTRACTION_BINDING_INDEX_SCHEMA_VERSION,
  EXTRACTION_REVIEW_INDEX_KIND,
  EXTRACTION_REVIEW_INDEX_SCHEMA_VERSION,
  EXTRACTION_REVIEW_RECEIPT_KIND,
  EXTRACTION_REVIEW_RECEIPT_SCHEMA_VERSION,
  EXTRACTION_SNAPSHOT_KIND,
  EXTRACTION_SNAPSHOT_SCHEMA_VERSION,
  LocalSermonExtractionStore,
  LocalSermonExtractionStoreError,
  MAX_EXTRACTION_REVIEW_RECEIPTS,
  MAX_EXTRACTION_REVIEW_RECEIPT_BYTES,
  MAX_EXTRACTION_SNAPSHOTS,
  MAX_EXTRACTION_SNAPSHOT_BYTES,
  MAX_REFERENCE_SCAN_FILES,
  MAX_REVIEW_RECEIPTS_PER_SNAPSHOT
};
