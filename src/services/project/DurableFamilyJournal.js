'use strict';

const crypto = require('crypto');
const nativeFs = require('fs');
const fs = require('fs/promises');
const path = require('path');

const {
  atomicWriteFile,
  ensurePrivateDirectory,
  fsyncDirectory,
  readFileNoFollow,
  statIdentityMatches
} = require('./StorageSafety');

const FAMILY_JOURNAL_FILE = 'pending-song-family.json';
const FAMILY_JOURNAL_PROVISION_MARKER_FILE =
  'pending-song-family.provisioned';
const FAMILY_JOURNAL_HIGH_WATER_FILE =
  'pending-song-family.high-water';
const FAMILY_JOURNAL_PROVISION_MARKER =
  'syncshow-family-journal-provisioned-v1\n';
const FAMILY_JOURNAL_CLEAR_KIND = 'syncshow-family-journal-clear';
const FAMILY_JOURNAL_CLEAR_RECORD = Object.freeze({
  schemaVersion: 1,
  kind: FAMILY_JOURNAL_CLEAR_KIND
});
const MAX_FAMILY_JOURNAL_PAYLOAD_BYTES = 512 * 1024;
const SLOT_HEADER_BYTES = 64;
const SLOT_BYTES = SLOT_HEADER_BYTES + MAX_FAMILY_JOURNAL_PAYLOAD_BYTES;
const FAMILY_JOURNAL_FILE_BYTES = SLOT_BYTES * 2;
const SLOT_MAGIC = Buffer.from('SyncShowFamilyJ1', 'ascii');
const SLOT_FORMAT_VERSION = 1;
const SLOT_GENERATION_OFFSET = 20;
const SLOT_LENGTH_OFFSET = 28;
const SLOT_CHECKSUM_OFFSET = 32;
const SLOT_CHECKSUM_BYTES = 32;
const HIGH_WATER_BYTES = 64;
const HIGH_WATER_MAGIC = Buffer.from('SyncShowFamHigh1', 'ascii');
const HIGH_WATER_GENERATION_OFFSET = 20;
const HIGH_WATER_CHECKSUM_OFFSET = 28;
const READ_WRITE_NOFOLLOW_FLAGS =
  nativeFs.constants.O_RDWR | (nativeFs.constants.O_NOFOLLOW || 0);

class DurableFamilyJournalError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'DurableFamilyJournalError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function fail(code, message, details = {}) {
  throw new DurableFamilyJournalError(code, message, details);
}

function canonicalPayload(record) {
  if (
    !record
    || typeof record !== 'object'
    || Array.isArray(record)
    || Object.getPrototypeOf(record) !== Object.prototype
  ) {
    fail(
      'FAMILY_JOURNAL_RECORD_INVALID',
      'The song-family journal record is invalid.'
    );
  }
  let text;
  try {
    text = JSON.stringify(record);
  } catch (_error) {
    fail(
      'FAMILY_JOURNAL_RECORD_INVALID',
      'The song-family journal record is not serializable.'
    );
  }
  const payload = Buffer.from(text, 'utf8');
  if (
    payload.length < 1
    || payload.length > MAX_FAMILY_JOURNAL_PAYLOAD_BYTES
  ) {
    fail(
      'FAMILY_JOURNAL_RECORD_INVALID',
      'The song-family journal record exceeds its durable bound.'
    );
  }
  return payload;
}

function isExactClearRecord(record) {
  return JSON.stringify(record) === JSON.stringify(
    FAMILY_JOURNAL_CLEAR_RECORD
  );
}

function checksumFor(generationBuffer, lengthBuffer, payload) {
  return crypto.createHash('sha256')
    .update(generationBuffer)
    .update(lengthBuffer)
    .update(payload)
    .digest();
}

function encodeSlot(generation, record) {
  if (
    !Number.isSafeInteger(generation)
    || generation < 1
  ) {
    fail(
      'FAMILY_JOURNAL_GENERATION_INVALID',
      'The song-family journal generation is invalid.'
    );
  }
  const payload = canonicalPayload(record);
  const slot = Buffer.alloc(SLOT_BYTES);
  SLOT_MAGIC.copy(slot, 0);
  slot.writeUInt32LE(SLOT_FORMAT_VERSION, 16);
  slot.writeBigUInt64LE(BigInt(generation), SLOT_GENERATION_OFFSET);
  slot.writeUInt32LE(payload.length, SLOT_LENGTH_OFFSET);
  const generationBuffer = slot.subarray(
    SLOT_GENERATION_OFFSET,
    SLOT_GENERATION_OFFSET + 8
  );
  const lengthBuffer = slot.subarray(
    SLOT_LENGTH_OFFSET,
    SLOT_LENGTH_OFFSET + 4
  );
  checksumFor(generationBuffer, lengthBuffer, payload)
    .copy(slot, SLOT_CHECKSUM_OFFSET);
  payload.copy(slot, SLOT_HEADER_BYTES);
  return slot;
}

function decodeSlot(slot, index) {
  if (
    slot.length !== SLOT_BYTES
    || !slot.subarray(0, SLOT_MAGIC.length).equals(SLOT_MAGIC)
    || slot.readUInt32LE(16) !== SLOT_FORMAT_VERSION
  ) {
    return null;
  }
  const generationBigInt = slot.readBigUInt64LE(SLOT_GENERATION_OFFSET);
  if (
    generationBigInt < 1n
    || generationBigInt > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    return null;
  }
  const length = slot.readUInt32LE(SLOT_LENGTH_OFFSET);
  if (length < 1 || length > MAX_FAMILY_JOURNAL_PAYLOAD_BYTES) {
    return null;
  }
  const payload = slot.subarray(
    SLOT_HEADER_BYTES,
    SLOT_HEADER_BYTES + length
  );
  if (
    slot.subarray(SLOT_HEADER_BYTES + length).some(byte => byte !== 0)
  ) {
    return null;
  }
  const generationBuffer = slot.subarray(
    SLOT_GENERATION_OFFSET,
    SLOT_GENERATION_OFFSET + 8
  );
  const lengthBuffer = slot.subarray(
    SLOT_LENGTH_OFFSET,
    SLOT_LENGTH_OFFSET + 4
  );
  const expectedChecksum = checksumFor(
    generationBuffer,
    lengthBuffer,
    payload
  );
  const actualChecksum = slot.subarray(
    SLOT_CHECKSUM_OFFSET,
    SLOT_CHECKSUM_OFFSET + SLOT_CHECKSUM_BYTES
  );
  if (!crypto.timingSafeEqual(actualChecksum, expectedChecksum)) return null;
  let record;
  const text = payload.toString('utf8');
  try {
    record = JSON.parse(text);
  } catch (_error) {
    return null;
  }
  if (
    !record
    || typeof record !== 'object'
    || Array.isArray(record)
    || Object.getPrototypeOf(record) !== Object.prototype
    || JSON.stringify(record) !== text
  ) {
    return null;
  }
  return Object.freeze({
    index,
    generation: Number(generationBigInt),
    record: Object.freeze(record)
  });
}

function encodeHighWater(generation) {
  if (!Number.isSafeInteger(generation) || generation < 1) {
    fail(
      'FAMILY_JOURNAL_GENERATION_INVALID',
      'The song-family journal high-water generation is invalid.'
    );
  }
  const buffer = Buffer.alloc(HIGH_WATER_BYTES);
  HIGH_WATER_MAGIC.copy(buffer, 0);
  buffer.writeUInt32LE(SLOT_FORMAT_VERSION, 16);
  buffer.writeBigUInt64LE(
    BigInt(generation),
    HIGH_WATER_GENERATION_OFFSET
  );
  crypto.createHash('sha256')
    .update(buffer.subarray(
      HIGH_WATER_GENERATION_OFFSET,
      HIGH_WATER_GENERATION_OFFSET + 8
    ))
    .digest()
    .copy(buffer, HIGH_WATER_CHECKSUM_OFFSET);
  return buffer;
}

function decodeHighWater(buffer) {
  if (
    buffer.length !== HIGH_WATER_BYTES
    || !buffer.subarray(0, HIGH_WATER_MAGIC.length).equals(HIGH_WATER_MAGIC)
    || buffer.readUInt32LE(16) !== SLOT_FORMAT_VERSION
    || buffer.subarray(60).some(byte => byte !== 0)
  ) {
    return null;
  }
  const generationBigInt = buffer.readBigUInt64LE(
    HIGH_WATER_GENERATION_OFFSET
  );
  if (
    generationBigInt < 1n
    || generationBigInt > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    return null;
  }
  const expected = crypto.createHash('sha256')
    .update(buffer.subarray(
      HIGH_WATER_GENERATION_OFFSET,
      HIGH_WATER_GENERATION_OFFSET + 8
    ))
    .digest();
  const actual = buffer.subarray(
    HIGH_WATER_CHECKSUM_OFFSET,
    HIGH_WATER_CHECKSUM_OFFSET + 32
  );
  return crypto.timingSafeEqual(actual, expected)
    ? Number(generationBigInt)
    : null;
}

async function readExactly(handle, buffer, position) {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(
      buffer,
      offset,
      buffer.length - offset,
      position + offset
    );
    if (bytesRead === 0) {
      fail(
        'FAMILY_JOURNAL_CORRUPT',
        'The durable song-family journal ended unexpectedly.'
      );
    }
    offset += bytesRead;
  }
}

async function writeExactly(handle, buffer, position) {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(
      buffer,
      offset,
      buffer.length - offset,
      position + offset
    );
    if (bytesWritten === 0) {
      fail(
        'FAMILY_JOURNAL_WRITE_FAILED',
        'The durable song-family journal stopped accepting data.'
      );
    }
    offset += bytesWritten;
  }
}

function activeSlot(slots) {
  const valid = slots.filter(Boolean);
  if (valid.length === 0) {
    fail(
      'FAMILY_JOURNAL_CORRUPT',
      'Both durable song-family journal slots are invalid.'
    );
  }
  if (
    valid.length === 2
    && valid[0].generation === valid[1].generation
  ) {
    fail(
      'FAMILY_JOURNAL_CORRUPT',
      'The durable song-family journal has conflicting generations.'
    );
  }
  if (
    valid.length === 2
    && Math.abs(valid[0].generation - valid[1].generation) !== 1
  ) {
    fail(
      'FAMILY_JOURNAL_CORRUPT',
      'The durable song-family journal has a nonconsecutive slot history.'
    );
  }
  return valid.reduce((latest, candidate) =>
    !latest || candidate.generation > latest.generation
      ? candidate
      : latest, null);
}

function witnessedSlot(slots, generation) {
  const matches = slots.filter(slot =>
    slot?.generation === generation);
  if (matches.length !== 1) {
    fail(
      'FAMILY_JOURNAL_CORRUPT',
      'The durable song-family journal does not contain its witnessed generation.'
    );
  }
  return matches[0];
}

class DurableFamilyJournal {
  constructor({ rootPath, fileName = FAMILY_JOURNAL_FILE } = {}) {
    if (
      typeof rootPath !== 'string'
      || !path.isAbsolute(rootPath)
      || fileName !== FAMILY_JOURNAL_FILE
    ) {
      throw new TypeError(
        'DurableFamilyJournal requires its fixed absolute storage root'
      );
    }
    this.rootPath = path.resolve(rootPath);
    this.filePath = path.join(this.rootPath, FAMILY_JOURNAL_FILE);
    this.markerPath = path.join(
      this.rootPath,
      FAMILY_JOURNAL_PROVISION_MARKER_FILE
    );
    this.highWaterPath = path.join(
      this.rootPath,
      FAMILY_JOURNAL_HIGH_WATER_FILE
    );
  }

  async _markerIsPresent() {
    try {
      const { buffer } = await readFileNoFollow(this.markerPath, 128);
      if (buffer.toString('utf8') !== FAMILY_JOURNAL_PROVISION_MARKER) {
        fail(
          'FAMILY_JOURNAL_CORRUPT',
          'The durable song-family journal provisioning marker is invalid.'
        );
      }
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      if (error instanceof DurableFamilyJournalError) throw error;
      fail(
        'FAMILY_JOURNAL_CORRUPT',
        'The durable song-family journal provisioning marker is unsafe.',
        { cause: error.code || error.name || 'marker-read-failed' }
      );
    }
  }

  async _openInitialized() {
    this.rootPath = await ensurePrivateDirectory(this.rootPath);
    this.filePath = path.join(this.rootPath, FAMILY_JOURNAL_FILE);
    this.markerPath = path.join(
      this.rootPath,
      FAMILY_JOURNAL_PROVISION_MARKER_FILE
    );
    this.highWaterPath = path.join(
      this.rootPath,
      FAMILY_JOURNAL_HIGH_WATER_FILE
    );
    const markerPresent = await this._markerIsPresent();
    let journalPresent = false;
    let highWaterPresent = false;
    try {
      const stats = await fs.lstat(this.filePath);
      journalPresent = true;
      if (!stats.isFile() || stats.isSymbolicLink()) {
        fail(
          'FAMILY_JOURNAL_CORRUPT',
          'The durable song-family journal file is unsafe.'
        );
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    try {
      const stats = await fs.lstat(this.highWaterPath);
      highWaterPresent = true;
      if (
        !stats.isFile()
        || stats.isSymbolicLink()
        || stats.size !== HIGH_WATER_BYTES
      ) {
        fail(
          'FAMILY_JOURNAL_CORRUPT',
          'The durable song-family journal high-water file is unsafe.'
        );
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (markerPresent && (!journalPresent || !highWaterPresent)) {
      fail(
        'FAMILY_JOURNAL_MISSING',
        'The provisioned durable song-family journal or its high-water witness is missing.'
      );
    }
    if (!markerPresent && highWaterPresent && !journalPresent) {
      fail(
        'FAMILY_JOURNAL_MISSING',
        'The durable song-family journal disappeared during provisioning.'
      );
    }
    let handle;
    let highWaterHandle;
    let created = false;
    if (!journalPresent) {
      try {
        handle = await fs.open(
          this.filePath,
          nativeFs.constants.O_CREAT
            | nativeFs.constants.O_EXCL
            | READ_WRITE_NOFOLLOW_FLAGS,
          0o600
        );
        created = true;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    }
    if (created) {
      try {
        await handle.truncate(FAMILY_JOURNAL_FILE_BYTES);
        await writeExactly(
          handle,
          encodeSlot(1, FAMILY_JOURNAL_CLEAR_RECORD),
          0
        );
        await handle.sync();
      } catch (error) {
        await handle.close().catch(() => {});
        throw error;
      }
      await handle.close();
      try {
        await fsyncDirectory(this.rootPath);
      } catch (error) {
        if (
          process.platform !== 'win32'
          || !['EINVAL', 'EPERM', 'EBADF', 'EACCES'].includes(error.code)
        ) {
          throw error;
        }
      }
      handle = null;
    }

    const before = await fs.lstat(this.filePath);
    if (
      !before.isFile()
      || before.isSymbolicLink()
      || before.size !== FAMILY_JOURNAL_FILE_BYTES
    ) {
      fail(
        'FAMILY_JOURNAL_CORRUPT',
        'The durable song-family journal file is unsafe.'
      );
    }
    const beforeRealPath = await fs.realpath(this.filePath);
    try {
      handle = await fs.open(this.filePath, READ_WRITE_NOFOLLOW_FLAGS);
      const opened = await handle.stat();
      const after = await fs.lstat(this.filePath);
      const afterRealPath = await fs.realpath(this.filePath);
      if (
        !opened.isFile()
        || opened.size !== FAMILY_JOURNAL_FILE_BYTES
        || !statIdentityMatches(before, opened)
        || !statIdentityMatches(opened, after)
        || after.isSymbolicLink()
        || beforeRealPath !== afterRealPath
      ) {
        fail(
          'FAMILY_JOURNAL_CORRUPT',
          'The durable song-family journal changed while opening.'
        );
      }
      const physicalActive = activeSlot(await this._readSlots(handle));
      if (!highWaterPresent) {
        if (
          markerPresent
          || physicalActive.generation !== 1
          || !isExactClearRecord(physicalActive.record)
        ) {
          fail(
            'FAMILY_JOURNAL_CORRUPT',
            'The durable song-family journal high-water witness is missing.'
          );
        }
        highWaterHandle = await fs.open(
          this.highWaterPath,
          nativeFs.constants.O_CREAT
            | nativeFs.constants.O_EXCL
            | READ_WRITE_NOFOLLOW_FLAGS,
          0o600
        );
        await writeExactly(
          highWaterHandle,
          encodeHighWater(physicalActive.generation),
          0
        );
        await highWaterHandle.sync();
        await highWaterHandle.close();
        highWaterHandle = null;
        highWaterPresent = true;
      }
      highWaterHandle = await fs.open(
        this.highWaterPath,
        READ_WRITE_NOFOLLOW_FLAGS
      );
      const highWaterBuffer = Buffer.alloc(HIGH_WATER_BYTES);
      await readExactly(highWaterHandle, highWaterBuffer, 0);
      let witnessedGeneration = decodeHighWater(highWaterBuffer);
      if (witnessedGeneration === null) {
        fail(
          'FAMILY_JOURNAL_CORRUPT',
          'The durable song-family journal high-water witness is invalid.'
        );
      }
      const currentSlots = await this._readSlots(handle);
      const physicalLatest = activeSlot(currentSlots);
      if (witnessedGeneration > physicalLatest.generation) {
        fail(
          'FAMILY_JOURNAL_CORRUPT',
          'The durable song-family journal is older than its high-water witness.'
        );
      }
      if (witnessedGeneration < physicalLatest.generation) {
        // A fully checksummed slot is written and fsynced before its
        // high-water witness. Completing that one-way advance is safe after
        // a crash in between those two writes, and prevents replay of an
        // older valid witness from hiding a newer pending transaction.
        await writeExactly(
          highWaterHandle,
          encodeHighWater(physicalLatest.generation),
          0
        );
        await highWaterHandle.sync();
        const advancedHighWater = Buffer.alloc(HIGH_WATER_BYTES);
        await readExactly(highWaterHandle, advancedHighWater, 0);
        if (
          decodeHighWater(advancedHighWater) !== physicalLatest.generation
        ) {
          fail(
            'FAMILY_JOURNAL_WRITE_FAILED',
            'The durable song-family journal could not advance its high-water witness.'
          );
        }
        witnessedGeneration = physicalLatest.generation;
      }
      witnessedSlot(currentSlots, witnessedGeneration);
      await this._verifyLiveHandle(
        highWaterHandle,
        this.highWaterPath,
        HIGH_WATER_BYTES
      );
      if (!markerPresent) {
        await atomicWriteFile(
          this.markerPath,
          FAMILY_JOURNAL_PROVISION_MARKER,
          {
            rootPath: this.rootPath,
            maximumBytes: 128,
            mode: 0o600
          }
        );
        await this._verifyLiveHandle(
          handle,
          this.filePath,
          FAMILY_JOURNAL_FILE_BYTES
        );
        await this._verifyLiveHandle(
          highWaterHandle,
          this.highWaterPath,
          HIGH_WATER_BYTES
        );
      }
      return Object.freeze({
        handle,
        highWaterHandle,
        witnessedGeneration
      });
    } catch (error) {
      await handle?.close().catch(() => {});
      await highWaterHandle?.close().catch(() => {});
      throw error;
    }
  }

  async _readSlots(handle) {
    const buffer = Buffer.alloc(FAMILY_JOURNAL_FILE_BYTES);
    await readExactly(handle, buffer, 0);
    return [
      decodeSlot(buffer.subarray(0, SLOT_BYTES), 0),
      decodeSlot(buffer.subarray(SLOT_BYTES), 1)
    ];
  }

  async _verifyLiveHandle(handle, livePath, expectedBytes) {
    const opened = await handle.stat();
    const live = await fs.lstat(livePath);
    const liveRealPath = await fs.realpath(livePath);
    if (
      !opened.isFile()
      || opened.size !== expectedBytes
      || !statIdentityMatches(opened, live)
      || live.isSymbolicLink()
      || liveRealPath !== livePath
    ) {
      fail(
        'FAMILY_JOURNAL_CORRUPT',
        'The durable song-family journal path changed during use.'
      );
    }
  }

  async read() {
    const opened = await this._openInitialized();
    try {
      const active = witnessedSlot(
        await this._readSlots(opened.handle),
        opened.witnessedGeneration
      );
      await this._verifyLiveHandle(
        opened.handle,
        this.filePath,
        FAMILY_JOURNAL_FILE_BYTES
      );
      await this._verifyLiveHandle(
        opened.highWaterHandle,
        this.highWaterPath,
        HIGH_WATER_BYTES
      );
      return Object.freeze({
        generation: active.generation,
        clear: isExactClearRecord(active.record),
        record: active.record
      });
    } finally {
      await opened.handle.close();
      await opened.highWaterHandle.close();
    }
  }

  async write(record) {
    const payload = canonicalPayload(record);
    const exactRecord = JSON.parse(payload.toString('utf8'));
    if (
      exactRecord.kind === FAMILY_JOURNAL_CLEAR_KIND
      && !isExactClearRecord(exactRecord)
    ) {
      fail(
        'FAMILY_JOURNAL_RECORD_INVALID',
        'The durable song-family clear record must be exact.'
      );
    }
    const opened = await this._openInitialized();
    try {
      const slots = await this._readSlots(opened.handle);
      const active = witnessedSlot(
        slots,
        opened.witnessedGeneration
      );
      if (active.generation >= Number.MAX_SAFE_INTEGER) {
        fail(
          'FAMILY_JOURNAL_GENERATION_INVALID',
          'The durable song-family journal exhausted its generations.'
        );
      }
      const targetIndex = active.index === 0 ? 1 : 0;
      const generation = active.generation + 1;
      await writeExactly(
        opened.handle,
        encodeSlot(generation, exactRecord),
        targetIndex * SLOT_BYTES
      );
      await opened.handle.sync();
      const writtenBuffer = Buffer.alloc(SLOT_BYTES);
      await readExactly(
        opened.handle,
        writtenBuffer,
        targetIndex * SLOT_BYTES
      );
      const verified = decodeSlot(writtenBuffer, targetIndex);
      if (
        !verified
        || verified.generation !== generation
        || JSON.stringify(verified.record) !== JSON.stringify(exactRecord)
      ) {
        fail(
          'FAMILY_JOURNAL_WRITE_FAILED',
          'The durable song-family journal could not verify its saved record.'
        );
      }
      await writeExactly(
        opened.highWaterHandle,
        encodeHighWater(generation),
        0
      );
      await opened.highWaterHandle.sync();
      const verifiedHighWater = Buffer.alloc(HIGH_WATER_BYTES);
      await readExactly(
        opened.highWaterHandle,
        verifiedHighWater,
        0
      );
      if (decodeHighWater(verifiedHighWater) !== generation) {
        fail(
          'FAMILY_JOURNAL_WRITE_FAILED',
          'The durable song-family journal could not verify its high-water witness.'
        );
      }
      await this._verifyLiveHandle(
        opened.handle,
        this.filePath,
        FAMILY_JOURNAL_FILE_BYTES
      );
      await this._verifyLiveHandle(
        opened.highWaterHandle,
        this.highWaterPath,
        HIGH_WATER_BYTES
      );
      return Object.freeze({
        generation,
        clear: isExactClearRecord(exactRecord),
        record: Object.freeze(exactRecord)
      });
    } finally {
      await opened.handle.close();
      await opened.highWaterHandle.close();
    }
  }

  clear() {
    return this.write(FAMILY_JOURNAL_CLEAR_RECORD);
  }
}

module.exports = {
  FAMILY_JOURNAL_CLEAR_KIND,
  FAMILY_JOURNAL_CLEAR_RECORD,
  FAMILY_JOURNAL_FILE,
  FAMILY_JOURNAL_FILE_BYTES,
  FAMILY_JOURNAL_HIGH_WATER_FILE,
  FAMILY_JOURNAL_PROVISION_MARKER,
  FAMILY_JOURNAL_PROVISION_MARKER_FILE,
  MAX_FAMILY_JOURNAL_PAYLOAD_BYTES,
  SLOT_BYTES,
  SLOT_HEADER_BYTES,
  DurableFamilyJournal,
  DurableFamilyJournalError
};
