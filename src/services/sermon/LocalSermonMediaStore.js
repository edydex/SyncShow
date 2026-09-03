'use strict';

const crypto = require('crypto');
const nativeFs = require('fs');
const fs = require('fs/promises');
const path = require('path');

const {
  NOFOLLOW_READ_FLAGS,
  ensureConfinedDirectory,
  ensurePrivateDirectory,
  fsyncDirectory,
  statIdentityMatches,
  withExclusiveFileLock
} = require('../project/StorageSafety');

const DEFAULT_MAX_MEDIA_BYTES = 1024 * 1024 * 1024;
const MEDIA_IO_CHUNK_BYTES = 1024 * 1024;
const MP3_FRAME_SEARCH_BYTES = 64 * 1024;
const MAX_ISO_BOXES = 100_000;
const OBJECT_ID_PATTERN = /^sha256:([a-f0-9]{64})$/;

const MEDIA_TYPES = Object.freeze({
  '.mp3': Object.freeze({
    extension: '.mp3',
    kind: 'audio',
    mediaType: 'audio/mpeg',
    format: 'mp3'
  }),
  '.m4a': Object.freeze({
    extension: '.m4a',
    kind: 'audio',
    mediaType: 'audio/mp4',
    format: 'm4a'
  }),
  '.mp4': Object.freeze({
    extension: '.mp4',
    kind: 'video',
    mediaType: 'video/mp4',
    format: 'mp4'
  })
});

class LocalSermonMediaStoreError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'LocalSermonMediaStoreError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new LocalSermonMediaStoreError(code, message, details);
}

function assertMediaReadSignal(signal) {
  if (signal === undefined || signal === null) return null;
  if (
    typeof signal !== 'object'
    || typeof signal.aborted !== 'boolean'
    || typeof signal.addEventListener !== 'function'
    || typeof signal.removeEventListener !== 'function'
  ) {
    fail('INVALID_MEDIA_METADATA', 'The sermon recording read signal is invalid.');
  }
  if (signal.aborted) {
    fail('READ_ABORTED', 'The sermon recording read was stopped.');
  }
  return signal;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function mediaTypeForName(fileName) {
  const mediaType = MEDIA_TYPES[path.extname(fileName).toLowerCase()];
  if (!mediaType) {
    fail(
      'UNSUPPORTED_MEDIA_TYPE',
      'Sermon recordings must be MP3, M4A, or MP4 files.'
    );
  }
  return mediaType;
}

function safeFileName(sourcePath) {
  const fileName = path.basename(sourcePath).trim().normalize('NFC');
  if (
    !fileName
    || fileName === '.'
    || fileName === '..'
    || fileName.length > 255
    || fileName.includes('/')
    || fileName.includes('\\')
    || /^[A-Za-z]:/u.test(fileName)
    || /[\u0000-\u001f\u007f]/u.test(fileName)
  ) {
    fail('INVALID_MEDIA_METADATA', 'The selected recording has an unsupported file name.');
  }
  mediaTypeForName(fileName);
  return fileName;
}

function safeMetadataFileName(value) {
  if (
    typeof value !== 'string'
    || value !== path.basename(value)
    || value.includes('/')
    || value.includes('\\')
    || /^[A-Za-z]:/u.test(value)
  ) {
    fail('INVALID_MEDIA_METADATA', 'Sermon recording fileName must be a file name, not a path.');
  }
  return safeFileName(value);
}

function expectedSize(value, maximumBytes) {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximumBytes) {
    fail('INVALID_MEDIA_METADATA', 'Expected sermon recording size is invalid.');
  }
  return value;
}

function normalizeExpectedMedia(raw, maximumBytes) {
  const exactKeys = [
    'durationSeconds',
    'fileName',
    'kind',
    'mediaType',
    'sha256',
    'sizeBytes'
  ];
  if (
    !raw
    || typeof raw !== 'object'
    || Array.isArray(raw)
    || Object.keys(raw).sort().join('\n') !== exactKeys.join('\n')
  ) {
    fail(
      'MEDIA_RESTORE_MISMATCH',
      'The expected sermon recording metadata is incomplete or unsupported.'
    );
  }
  let fileName;
  let fileType;
  try {
    fileName = safeMetadataFileName(raw.fileName);
    fileType = mediaTypeForName(fileName);
  } catch (error) {
    if (error instanceof LocalSermonMediaStoreError) {
      fail(
        'MEDIA_RESTORE_MISMATCH',
        'The expected sermon recording metadata is incomplete or unsupported.'
      );
    }
    throw error;
  }
  if (
    raw.kind !== fileType.kind
    || raw.mediaType !== fileType.mediaType
    || !/^[a-f0-9]{64}$/u.test(raw.sha256 || '')
    || !Number.isSafeInteger(raw.sizeBytes)
    || raw.sizeBytes < 1
    || raw.sizeBytes > maximumBytes
    || raw.durationSeconds !== null
  ) {
    fail(
      'MEDIA_RESTORE_MISMATCH',
      'The expected sermon recording metadata is incomplete or unsupported.'
    );
  }
  return deepFreeze({
    kind: raw.kind,
    mediaType: raw.mediaType,
    fileName,
    sha256: raw.sha256,
    sizeBytes: raw.sizeBytes,
    durationSeconds: null
  });
}

async function readExact(handle, length, position, message) {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(
      buffer,
      offset,
      length - offset,
      position + offset
    );
    if (bytesRead === 0) fail('CORRUPT_MEDIA', message);
    offset += bytesRead;
  }
  return buffer;
}

function synchsafeInteger(bytes) {
  if (bytes.length !== 4 || bytes.some(byte => (byte & 0x80) !== 0)) {
    fail('CORRUPT_MEDIA', 'The MP3 ID3 header is invalid.');
  }
  return (
    (bytes[0] << 21)
    | (bytes[1] << 14)
    | (bytes[2] << 7)
    | bytes[3]
  ) >>> 0;
}

function mp3Frame(buffer, offset = 0) {
  if (offset < 0 || offset + 4 > buffer.length) return null;
  const first = buffer[offset];
  const second = buffer[offset + 1];
  const third = buffer[offset + 2];
  if (first !== 0xff || (second & 0xe0) !== 0xe0) return null;

  const versionBits = (second >>> 3) & 0x03;
  const layerBits = (second >>> 1) & 0x03;
  const bitrateIndex = (third >>> 4) & 0x0f;
  const sampleRateIndex = (third >>> 2) & 0x03;
  const padding = (third >>> 1) & 0x01;
  if (
    versionBits === 0x01
    || layerBits !== 0x01
    || bitrateIndex === 0
    || bitrateIndex === 0x0f
    || sampleRateIndex === 0x03
  ) {
    return null;
  }

  const mpeg1 = versionBits === 0x03;
  const bitrateTable = mpeg1
    ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
    : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
  const sampleRates = versionBits === 0x03
    ? [44100, 48000, 32000]
    : versionBits === 0x02
      ? [22050, 24000, 16000]
      : [11025, 12000, 8000];
  const bitrate = bitrateTable[bitrateIndex] * 1000;
  const sampleRate = sampleRates[sampleRateIndex];
  const frameLength = Math.floor(((mpeg1 ? 144 : 72) * bitrate) / sampleRate) + padding;
  if (frameLength < 24 || frameLength > 4096) return null;
  return {
    frameLength,
    versionBits,
    layerBits,
    sampleRateIndex
  };
}

async function validateMp3(handle, sizeBytes) {
  if (sizeBytes < 8) {
    fail('CORRUPT_MEDIA', 'The selected MP3 is incomplete.');
  }
  const prefixLength = Math.min(10, sizeBytes);
  const prefix = await readExact(
    handle,
    prefixLength,
    0,
    'The selected MP3 is incomplete.'
  );
  let searchStart = 0;
  if (prefixLength >= 10 && prefix.subarray(0, 3).toString('ascii') === 'ID3') {
    if (prefix[3] < 2 || prefix[3] > 4 || prefix[4] === 0xff) {
      fail('CORRUPT_MEDIA', 'The MP3 ID3 version is unsupported.');
    }
    const tagSize = synchsafeInteger(prefix.subarray(6, 10));
    const footerSize = prefix[3] === 4 && (prefix[5] & 0x10) !== 0 ? 10 : 0;
    searchStart = 10 + tagSize + footerSize;
    if (searchStart > sizeBytes - 4) {
      fail('CORRUPT_MEDIA', 'The MP3 ID3 tag extends beyond the selected file.');
    }
  }

  const searchLength = Math.min(
    MP3_FRAME_SEARCH_BYTES,
    sizeBytes - searchStart
  );
  const window = await readExact(
    handle,
    searchLength,
    searchStart,
    'The selected MP3 has no complete audio frame.'
  );
  let firstFrame = null;
  let firstPosition = -1;
  for (let offset = 0; offset <= window.length - 4; offset += 1) {
    const candidate = mp3Frame(window, offset);
    if (!candidate) continue;
    const absolutePosition = searchStart + offset;
    if (absolutePosition + candidate.frameLength + 4 > sizeBytes) continue;
    const nextHeader = await readExact(
      handle,
      4,
      absolutePosition + candidate.frameLength,
      'The selected MP3 has a truncated audio frame.'
    );
    const nextFrame = mp3Frame(nextHeader);
    if (
      nextFrame
      && nextFrame.versionBits === candidate.versionBits
      && nextFrame.layerBits === candidate.layerBits
      && nextFrame.sampleRateIndex === candidate.sampleRateIndex
    ) {
      firstFrame = candidate;
      firstPosition = absolutePosition;
      break;
    }
  }
  if (!firstFrame || firstPosition < 0) {
    fail(
      'MEDIA_TYPE_MISMATCH',
      'The selected .mp3 file does not contain a verified MP3 audio stream.'
    );
  }
}

async function isoBoxHeader(handle, position, boundary) {
  if (boundary - position < 8) {
    fail('CORRUPT_MEDIA', 'The MP4 container ends with an incomplete box header.');
  }
  const header = await readExact(
    handle,
    8,
    position,
    'The MP4 container has an incomplete box header.'
  );
  let size = header.readUInt32BE(0);
  const type = header.subarray(4, 8).toString('latin1');
  let headerSize = 8;
  if (size === 1) {
    if (boundary - position < 16) {
      fail('CORRUPT_MEDIA', 'The MP4 container has an incomplete extended box header.');
    }
    const extended = await readExact(
      handle,
      8,
      position + 8,
      'The MP4 container has an incomplete extended box size.'
    );
    const extendedSize = extended.readBigUInt64BE(0);
    if (extendedSize > BigInt(Number.MAX_SAFE_INTEGER)) {
      fail('CORRUPT_MEDIA', 'The MP4 container declares an unsupported box size.');
    }
    size = Number(extendedSize);
    headerSize = 16;
  } else if (size === 0) {
    size = boundary - position;
  }
  if (
    size < headerSize
    || position + size > boundary
    || !/^[\x20-\x7e\xa9]{4}$/u.test(type)
  ) {
    fail('CORRUPT_MEDIA', 'The MP4 container has an invalid box.');
  }
  return {
    type,
    start: position,
    dataStart: position + headerSize,
    end: position + size
  };
}

async function directIsoBoxes(handle, start, end, counter) {
  const boxes = [];
  let position = start;
  while (position < end) {
    counter.count += 1;
    if (counter.count > MAX_ISO_BOXES) {
      fail('CORRUPT_MEDIA', 'The MP4 container contains too many boxes.');
    }
    const box = await isoBoxHeader(handle, position, end);
    boxes.push(box);
    if (box.end <= position) {
      fail('CORRUPT_MEDIA', 'The MP4 container contains a non-advancing box.');
    }
    position = box.end;
  }
  if (position !== end) {
    fail('CORRUPT_MEDIA', 'The MP4 container box boundaries are inconsistent.');
  }
  return boxes;
}

async function isoTrackHandlers(handle, moov, counter) {
  const handlers = [];
  const moovChildren = await directIsoBoxes(handle, moov.dataStart, moov.end, counter);
  for (const track of moovChildren.filter(box => box.type === 'trak')) {
    const trackChildren = await directIsoBoxes(handle, track.dataStart, track.end, counter);
    for (const media of trackChildren.filter(box => box.type === 'mdia')) {
      const mediaChildren = await directIsoBoxes(handle, media.dataStart, media.end, counter);
      for (const handler of mediaChildren.filter(box => box.type === 'hdlr')) {
        if (handler.end - handler.dataStart < 12) {
          fail('CORRUPT_MEDIA', 'The MP4 media handler is incomplete.');
        }
        const payload = await readExact(
          handle,
          12,
          handler.dataStart,
          'The MP4 media handler is incomplete.'
        );
        handlers.push(payload.subarray(8, 12).toString('latin1'));
      }
    }
  }
  return handlers;
}

async function validateIsoMedia(handle, sizeBytes, format) {
  if (sizeBytes < 24) {
    fail('CORRUPT_MEDIA', 'The selected MP4 container is incomplete.');
  }
  const counter = { count: 0 };
  const boxes = await directIsoBoxes(handle, 0, sizeBytes, counter);
  if (boxes[0]?.type !== 'ftyp' || boxes[0].end - boxes[0].dataStart < 8) {
    fail(
      'MEDIA_TYPE_MISMATCH',
      'The selected file is not a supported MP4-family container.'
    );
  }
  const ftypLength = boxes[0].end - boxes[0].dataStart;
  if (ftypLength > 1024 * 1024 || ftypLength % 4 !== 0) {
    fail('CORRUPT_MEDIA', 'The MP4 file-type box is invalid.');
  }
  const ftyp = await readExact(
    handle,
    ftypLength,
    boxes[0].dataStart,
    'The MP4 file-type box is incomplete.'
  );
  const brands = [];
  for (let offset = 0; offset + 4 <= ftyp.length; offset += 4) {
    brands.push(ftyp.subarray(offset, offset + 4).toString('latin1'));
  }
  const recognizedBrand = brands.some(brand =>
    /^(?:isom|iso[2-9]|mp4[12]|M4A |M4B |avc1|dash|qt  )$/u.test(brand));
  if (!recognizedBrand) {
    fail('MEDIA_TYPE_MISMATCH', 'The selected MP4-family brand is unsupported.');
  }

  const moov = boxes.find(box => box.type === 'moov');
  const mediaData = boxes.find(box => box.type === 'mdat');
  if (!moov || !mediaData || mediaData.end - mediaData.dataStart < 1) {
    fail('CORRUPT_MEDIA', 'The MP4 container needs movie metadata and media data.');
  }
  const handlers = await isoTrackHandlers(handle, moov, counter);
  if (format === 'm4a') {
    if (!handlers.includes('soun') || handlers.includes('vide')) {
      fail(
        'MEDIA_TYPE_MISMATCH',
        'The selected .m4a file must contain audio and no video track.'
      );
    }
  } else if (!handlers.includes('vide')) {
    fail('MEDIA_TYPE_MISMATCH', 'The selected .mp4 file must contain a video track.');
  }
}

async function validateMediaHandle(handle, sizeBytes, mediaType) {
  if (mediaType.format === 'mp3') {
    await validateMp3(handle, sizeBytes);
  } else {
    await validateIsoMedia(handle, sizeBytes, mediaType.format);
  }
}

async function writeAll(handle, buffer, position) {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(
      buffer,
      offset,
      buffer.length - offset,
      position + offset
    );
    if (bytesWritten === 0) {
      fail('STORE_UNAVAILABLE', 'The local sermon recording store stopped while saving.');
    }
    offset += bytesWritten;
  }
}

async function syncDirectory(directoryPath) {
  try {
    await fsyncDirectory(directoryPath);
  } catch (error) {
    if (
      process.platform !== 'win32'
      || !['EINVAL', 'EPERM', 'EBADF', 'EACCES'].includes(error.code)
    ) {
      throw error;
    }
  }
}

class LocalSermonMediaStore {
  constructor(options = {}) {
    if (typeof options.rootPath !== 'string' || !path.isAbsolute(options.rootPath)) {
      throw new TypeError('LocalSermonMediaStore requires an absolute rootPath');
    }
    const maximumBytes = options.maximumBytes ?? DEFAULT_MAX_MEDIA_BYTES;
    if (
      !Number.isSafeInteger(maximumBytes)
      || maximumBytes < 1
      || maximumBytes > DEFAULT_MAX_MEDIA_BYTES
    ) {
      throw new TypeError(
        `LocalSermonMediaStore maximumBytes must be between 1 and ${DEFAULT_MAX_MEDIA_BYTES}`
      );
    }
    this.rootPath = path.resolve(options.rootPath);
    this.maximumBytes = maximumBytes;
    this.randomUUID = options.randomUUID || crypto.randomUUID;
    if (typeof this.randomUUID !== 'function') {
      throw new TypeError('LocalSermonMediaStore randomUUID must be a function');
    }
  }

  async initialize() {
    try {
      this.rootPath = await ensurePrivateDirectory(this.rootPath);
      await ensureConfinedDirectory(this.rootPath, path.join(this.rootPath, 'objects'));
      await ensureConfinedDirectory(this.rootPath, path.join(this.rootPath, '.staging'));
    } catch (error) {
      if (error instanceof LocalSermonMediaStoreError) throw error;
      fail('STORE_UNAVAILABLE', 'The local sermon recording store is unavailable.');
    }
    return this;
  }

  _digestFromObjectId(objectId) {
    const match = OBJECT_ID_PATTERN.exec(objectId || '');
    if (!match) fail('INVALID_OBJECT_ID', 'The sermon recording object id is invalid.');
    return match[1];
  }

  _objectPath(digest) {
    return path.join(this.rootPath, 'objects', digest.slice(0, 2), digest);
  }

  _randomToken() {
    const token = String(this.randomUUID());
    if (!/^[A-Za-z0-9_-]{8,128}$/u.test(token)) {
      fail('STORE_UNAVAILABLE', 'The local sermon recording store could not create safe staging identity.');
    }
    return token;
  }

  async _assertStablePath(sourcePath, beforePath, opened, beforeRealPath) {
    const after = await opened.handle.stat();
    let afterPath;
    let afterRealPath;
    try {
      afterPath = await fs.lstat(sourcePath);
      afterRealPath = await fs.realpath(sourcePath);
    } catch (_error) {
      fail('UNSAFE_MEDIA', 'The selected recording changed while it was being read.');
    }
    if (
      !statIdentityMatches(opened.stats, after)
      || !statIdentityMatches(opened.stats, afterPath)
      || !statIdentityMatches(beforePath, afterPath)
      || afterPath.isSymbolicLink()
      || beforeRealPath !== afterRealPath
    ) {
      fail('UNSAFE_MEDIA', 'The selected recording changed while it was being read.');
    }
  }

  async _stageSource(sourcePath, mediaType) {
    let beforePath;
    let beforeRealPath;
    let sourceHandle;
    let stagingHandle;
    let stagingPath = null;
    let keepStaging = false;
    try {
      try {
        beforePath = await fs.lstat(sourcePath);
      } catch (_error) {
        fail('UNSAFE_MEDIA', 'The selected recording is unavailable.');
      }
      if (!beforePath.isFile() || beforePath.isSymbolicLink()) {
        fail('UNSAFE_MEDIA', 'The selected recording is not a safe regular file.');
      }
      if (beforePath.size < 1) {
        fail('EMPTY_MEDIA', 'The selected recording is empty.');
      }
      if (beforePath.size > this.maximumBytes) {
        fail(
          'MEDIA_TOO_LARGE',
          `The selected recording exceeds the ${this.maximumBytes}-byte limit.`
        );
      }
      try {
        beforeRealPath = await fs.realpath(sourcePath);
        sourceHandle = await fs.open(sourcePath, NOFOLLOW_READ_FLAGS);
      } catch (_error) {
        fail('UNSAFE_MEDIA', 'The selected recording could not be opened safely.');
      }
      const sourceStats = await sourceHandle.stat();
      if (!sourceStats.isFile() || !statIdentityMatches(beforePath, sourceStats)) {
        fail('UNSAFE_MEDIA', 'The selected recording changed while opening.');
      }
      const opened = { handle: sourceHandle, stats: sourceStats };
      await validateMediaHandle(sourceHandle, sourceStats.size, mediaType);

      const stagingDirectory = path.join(this.rootPath, '.staging');
      stagingPath = path.join(
        stagingDirectory,
        `.recording-${process.pid}-${this._randomToken()}.tmp`
      );
      stagingHandle = await fs.open(
        stagingPath,
        nativeFs.constants.O_WRONLY
          | nativeFs.constants.O_CREAT
          | nativeFs.constants.O_EXCL,
        0o600
      );
      if (process.platform !== 'win32') await stagingHandle.chmod(0o600);

      const hash = crypto.createHash('sha256');
      const buffer = Buffer.allocUnsafe(MEDIA_IO_CHUNK_BYTES);
      let position = 0;
      while (position < sourceStats.size) {
        const length = Math.min(buffer.length, sourceStats.size - position);
        const { bytesRead } = await sourceHandle.read(buffer, 0, length, position);
        if (bytesRead === 0) {
          fail('UNSAFE_MEDIA', 'The selected recording ended while being copied.');
        }
        const chunk = buffer.subarray(0, bytesRead);
        hash.update(chunk);
        await writeAll(stagingHandle, chunk, position);
        position += bytesRead;
      }
      await this._assertStablePath(sourcePath, beforePath, opened, beforeRealPath);
      await stagingHandle.sync();
      const stagingStats = await stagingHandle.stat();
      if (!stagingStats.isFile() || stagingStats.size !== sourceStats.size) {
        fail('STORE_UNAVAILABLE', 'The local sermon recording copy is incomplete.');
      }
      keepStaging = true;
      return {
        stagingPath,
        digest: hash.digest('hex'),
        sizeBytes: sourceStats.size
      };
    } finally {
      await stagingHandle?.close().catch(() => {});
      await sourceHandle?.close().catch(() => {});
      if (stagingPath && !keepStaging) await fs.unlink(stagingPath).catch(() => {});
    }
  }

  async _openVerifiedObject(objectId, options = {}) {
    const signal = assertMediaReadSignal(options.signal);
    await this.initialize();
    assertMediaReadSignal(signal);
    const digest = this._digestFromObjectId(objectId);
    const requiredSize = expectedSize(options.sizeBytes, this.maximumBytes);
    const mediaType = options.fileName
      ? mediaTypeForName(safeMetadataFileName(options.fileName))
      : options.mediaType
        ? Object.values(MEDIA_TYPES).find(type => type.mediaType === options.mediaType)
        : null;
    if (options.mediaType && (!mediaType || mediaType.mediaType !== options.mediaType)) {
      fail('INVALID_MEDIA_METADATA', 'Sermon recording media type is unsupported.');
    }
    const objectPath = this._objectPath(digest);
    let beforePath;
    let beforeRealPath;
    let handle;
    try {
      try {
        await ensureConfinedDirectory(this.rootPath, path.dirname(objectPath));
        beforePath = await fs.lstat(objectPath);
        beforeRealPath = await fs.realpath(objectPath);
      } catch (error) {
        if (error.code === 'ENOENT') {
          fail('OBJECT_NOT_FOUND', 'The sermon recording object is unavailable.');
        }
        fail('OBJECT_CORRUPT', 'The sermon recording object is unsafe or unavailable.');
      }
      assertMediaReadSignal(signal);
      if (
        !beforePath.isFile()
        || beforePath.isSymbolicLink()
        || beforePath.size < 1
        || beforePath.size > this.maximumBytes
        || (requiredSize !== null && beforePath.size !== requiredSize)
        || (process.platform !== 'win32' && (beforePath.mode & 0o077) !== 0)
      ) {
        fail('OBJECT_CORRUPT', 'The sermon recording object is unsafe or has an unexpected size.');
      }
      handle = await fs.open(objectPath, NOFOLLOW_READ_FLAGS);
      const opened = await handle.stat();
      assertMediaReadSignal(signal);
      if (!opened.isFile() || !statIdentityMatches(beforePath, opened)) {
        fail('OBJECT_CORRUPT', 'The sermon recording object changed while opening.');
      }
      if (mediaType) await validateMediaHandle(handle, opened.size, mediaType);
      assertMediaReadSignal(signal);

      const hash = crypto.createHash('sha256');
      const buffer = Buffer.allocUnsafe(MEDIA_IO_CHUNK_BYTES);
      let position = 0;
      while (position < opened.size) {
        assertMediaReadSignal(signal);
        const length = Math.min(buffer.length, opened.size - position);
        const { bytesRead } = await handle.read(buffer, 0, length, position);
        assertMediaReadSignal(signal);
        if (bytesRead === 0) {
          fail('OBJECT_CORRUPT', 'The sermon recording object ended during verification.');
        }
        hash.update(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
      assertMediaReadSignal(signal);
      const after = await handle.stat();
      const afterPath = await fs.lstat(objectPath);
      const afterRealPath = await fs.realpath(objectPath);
      assertMediaReadSignal(signal);
      if (
        hash.digest('hex') !== digest
        || !statIdentityMatches(opened, after)
        || !statIdentityMatches(opened, afterPath)
        || afterPath.isSymbolicLink()
        || beforeRealPath !== afterRealPath
      ) {
        fail(
          'OBJECT_CORRUPT',
          'The sermon recording object failed its content-addressed integrity check.'
        );
      }
      return {
        handle,
        objectId,
        digest,
        sizeBytes: opened.size,
        stats: opened,
        realPath: beforeRealPath
      };
    } catch (error) {
      await handle?.close().catch(() => {});
      if (error instanceof LocalSermonMediaStoreError) throw error;
      fail('OBJECT_CORRUPT', 'The sermon recording object is unsafe or unavailable.');
    }
  }

  async _installStaged(
    stagingPath,
    digest,
    sizeBytes,
    mediaType,
    { repairCorrupt = false } = {}
  ) {
    const objectId = `sha256:${digest}`;
    const objectPath = this._objectPath(digest);
    await ensureConfinedDirectory(this.rootPath, path.dirname(objectPath));
    return withExclusiveFileLock(
      path.join(this.rootPath, '.media-write-lock'),
      async () => {
        let corruptObject = false;
        try {
          const existing = await this._openVerifiedObject(objectId, {
            sizeBytes,
            mediaType: mediaType.mediaType
          });
          await existing.handle.close();
          return objectId;
        } catch (error) {
          if (error.code === 'OBJECT_CORRUPT' && repairCorrupt) {
            corruptObject = true;
          } else if (error.code !== 'OBJECT_NOT_FOUND') {
            throw error;
          }
        }

        let installed = false;
        let quarantinePath = null;
        let quarantined = false;
        try {
          if (corruptObject) {
            quarantinePath = path.join(
              path.dirname(objectPath),
              `.${digest}.corrupt-${this._randomToken()}.quarantine`
            );
            await fs.rename(objectPath, quarantinePath);
            quarantined = true;
            await syncDirectory(path.dirname(objectPath));
          }
          try {
            await fs.link(stagingPath, objectPath);
            installed = true;
          } catch (error) {
            if (error.code !== 'EEXIST') throw error;
          }
          if (installed && process.platform !== 'win32') await fs.chmod(objectPath, 0o600);
          const checked = await this._openVerifiedObject(objectId, {
            sizeBytes,
            mediaType: mediaType.mediaType
          });
          await checked.handle.close();
          await syncDirectory(path.dirname(objectPath));
          if (quarantined) {
            await fs.unlink(quarantinePath);
            quarantined = false;
            // The exact replacement is now the sole retained object. If the
            // following directory durability barrier fails, keep the verified
            // replacement rather than deleting both the old and new bytes.
            installed = false;
            await syncDirectory(path.dirname(objectPath));
          }
          return objectId;
        } catch (error) {
          if (installed) await fs.unlink(objectPath).catch(() => {});
          if (quarantined) {
            try {
              await fs.rename(quarantinePath, objectPath);
              quarantined = false;
              await syncDirectory(path.dirname(objectPath));
            } catch (rollbackError) {
              fail(
                'STORE_UNAVAILABLE',
                'The local sermon recording store could not restore its prior object.',
                {
                  cause: typeof rollbackError?.code === 'string'
                    ? rollbackError.code
                    : 'UNKNOWN'
                }
              );
            }
          }
          throw error;
        }
      }
    );
  }

  async importFile(options = {}) {
    await this.initialize();
    if (typeof options.sourcePath !== 'string' || !path.isAbsolute(options.sourcePath)) {
      fail('INVALID_MEDIA_PATH', 'Choose a sermon recording through SyncShow.');
    }
    const sourcePath = path.resolve(options.sourcePath);
    const fileName = safeFileName(sourcePath);
    const mediaType = mediaTypeForName(fileName);
    let staged = null;
    try {
      staged = await this._stageSource(sourcePath, mediaType);
      const objectId = await this._installStaged(
        staged.stagingPath,
        staged.digest,
        staged.sizeBytes,
        mediaType
      );
      return deepFreeze({
        objectId,
        media: {
          kind: mediaType.kind,
          mediaType: mediaType.mediaType,
          fileName,
          sha256: staged.digest,
          sizeBytes: staged.sizeBytes,
          durationSeconds: null
        }
      });
    } catch (error) {
      if (error instanceof LocalSermonMediaStoreError) throw error;
      if (error.code === 'WRITE_LOCKED') {
        fail('WRITE_LOCKED', 'The sermon recording store is already being updated.');
      }
      fail('STORE_UNAVAILABLE', 'The local sermon recording store could not save the recording.');
    } finally {
      if (staged?.stagingPath) {
        await fs.unlink(staged.stagingPath).catch(() => {});
        await fsyncDirectory(path.join(this.rootPath, '.staging')).catch(() => {});
      }
    }
  }

  async restoreFile(options = {}) {
    await this.initialize();
    if (typeof options.sourcePath !== 'string' || !path.isAbsolute(options.sourcePath)) {
      fail('INVALID_MEDIA_PATH', 'Choose a sermon recording through SyncShow.');
    }
    const expectedMedia = normalizeExpectedMedia(
      options.expectedMedia,
      this.maximumBytes
    );
    const sourcePath = path.resolve(options.sourcePath);
    let fileName;
    let mediaType;
    try {
      fileName = safeFileName(sourcePath);
      mediaType = mediaTypeForName(fileName);
    } catch (error) {
      if (
        error instanceof LocalSermonMediaStoreError
        && ['INVALID_MEDIA_METADATA', 'UNSUPPORTED_MEDIA_TYPE'].includes(error.code)
      ) {
        fail(
          'MEDIA_RESTORE_MISMATCH',
          'The selected recording does not exactly match the expected sermon recording.'
        );
      }
      throw error;
    }
    let staged = null;
    try {
      if (
        expectedMedia.kind !== mediaType.kind
        || expectedMedia.mediaType !== mediaType.mediaType
      ) {
        fail(
          'MEDIA_RESTORE_MISMATCH',
          'The selected recording does not exactly match the expected sermon recording.'
        );
      }
      staged = await this._stageSource(sourcePath, mediaType);
      if (
        expectedMedia.sha256 !== staged.digest
        || expectedMedia.sizeBytes !== staged.sizeBytes
      ) {
        fail(
          'MEDIA_RESTORE_MISMATCH',
          'The selected recording does not exactly match the expected sermon recording.'
        );
      }
      const objectId = await this._installStaged(
        staged.stagingPath,
        staged.digest,
        staged.sizeBytes,
        mediaType,
        { repairCorrupt: true }
      );
      return deepFreeze({
        objectId,
        media: { ...expectedMedia }
      });
    } catch (error) {
      if (error instanceof LocalSermonMediaStoreError) throw error;
      if (error.code === 'WRITE_LOCKED') {
        fail('WRITE_LOCKED', 'The sermon recording store is already being updated.');
      }
      fail(
        'STORE_UNAVAILABLE',
        'The local sermon recording store could not restore the recording.'
      );
    } finally {
      if (staged?.stagingPath) {
        await fs.unlink(staged.stagingPath).catch(() => {});
        await fsyncDirectory(path.join(this.rootPath, '.staging')).catch(() => {});
      }
    }
  }

  async checkObject(objectId, options = {}) {
    const opened = await this._openVerifiedObject(objectId, options);
    try {
      return deepFreeze({
        objectId,
        sha256: opened.digest,
        sizeBytes: opened.sizeBytes
      });
    } finally {
      await opened.handle.close().catch(() => {});
    }
  }

  async checkMedia(media) {
    if (!media || typeof media !== 'object' || Array.isArray(media)) {
      fail('INVALID_MEDIA_METADATA', 'Sermon recording metadata is required.');
    }
    const fileName = safeMetadataFileName(media.fileName);
    const mediaType = mediaTypeForName(fileName);
    if (
      media.kind !== mediaType.kind
      || media.mediaType !== mediaType.mediaType
      || !/^[a-f0-9]{64}$/u.test(media.sha256 || '')
      || !Number.isSafeInteger(media.sizeBytes)
      || media.sizeBytes < 1
      || media.durationSeconds !== null
    ) {
      fail('INVALID_MEDIA_METADATA', 'Sermon recording metadata is inconsistent.');
    }
    const objectId = `sha256:${media.sha256}`;
    await this.checkObject(objectId, {
      sizeBytes: media.sizeBytes,
      fileName,
      mediaType: media.mediaType
    });
    return deepFreeze({
      objectId,
      kind: media.kind,
      mediaType: media.mediaType,
      sha256: media.sha256,
      sizeBytes: media.sizeBytes
    });
  }

  async openMediaReadSession(media, options = {}) {
    if (!media || typeof media !== 'object' || Array.isArray(media)) {
      fail('INVALID_MEDIA_METADATA', 'Sermon recording metadata is required.');
    }
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      fail('INVALID_MEDIA_METADATA', 'Sermon recording read options are invalid.');
    }
    const signal = assertMediaReadSignal(options.signal);
    const fileName = safeMetadataFileName(media.fileName);
    const mediaType = mediaTypeForName(fileName);
    if (
      media.kind !== mediaType.kind
      || media.mediaType !== mediaType.mediaType
      || !/^[a-f0-9]{64}$/u.test(media.sha256 || '')
      || !Number.isSafeInteger(media.sizeBytes)
      || media.sizeBytes < 1
      || media.durationSeconds !== null
    ) {
      fail('INVALID_MEDIA_METADATA', 'Sermon recording metadata is inconsistent.');
    }

    const objectId = `sha256:${media.sha256}`;
    const opened = await this._openVerifiedObject(objectId, {
      sizeBytes: media.sizeBytes,
      fileName,
      mediaType: media.mediaType,
      signal
    });
    let closed = false;
    let closePromise = null;
    const closeHandle = () => {
      if (!closed) {
        closed = true;
        signal?.removeEventListener('abort', abortRead);
        closePromise = opened.handle.close().catch(() => {});
      }
      return closePromise || Promise.resolve();
    };
    const abortRead = () => {
      closeHandle();
    };
    try {
      assertMediaReadSignal(signal);
    } catch (error) {
      await opened.handle.close().catch(() => {});
      throw error;
    }
    signal?.addEventListener('abort', abortRead, { once: true });
    try {
      assertMediaReadSignal(signal);
    } catch (error) {
      await closeHandle();
      throw error;
    }
    return Object.freeze({
      objectId,
      kind: media.kind,
      mediaType: media.mediaType,
      sha256: media.sha256,
      sizeBytes: opened.sizeBytes,
      async read(offset, length) {
        if (closed) {
          fail(
            'READ_SESSION_CLOSED',
            'The sermon recording playback session is closed.'
          );
        }
        if (
          !Number.isSafeInteger(offset)
          || offset < 0
          || offset >= opened.sizeBytes
          || !Number.isSafeInteger(length)
          || length < 1
          || length > MEDIA_IO_CHUNK_BYTES
          || offset + length > opened.sizeBytes
        ) {
          fail(
            'INVALID_READ_RANGE',
            'The sermon recording playback range is invalid.'
          );
        }
        const buffer = Buffer.allocUnsafe(length);
        let bytesRead = 0;
        while (bytesRead < length) {
          const result = await opened.handle.read(
            buffer,
            bytesRead,
            length - bytesRead,
            offset + bytesRead
          );
          if (result.bytesRead === 0) {
            fail(
              'OBJECT_CORRUPT',
              'The sermon recording object ended while being read.'
            );
          }
          bytesRead += result.bytesRead;
        }
        const after = await opened.handle.stat();
        if (!statIdentityMatches(opened.stats, after)) {
          fail(
            'OBJECT_CORRUPT',
            'The sermon recording object changed during playback.'
          );
        }
        return buffer;
      },
      async close() {
        await closeHandle();
      }
    });
  }

  async *readObject(objectId, options = {}) {
    const opened = await this._openVerifiedObject(objectId, options);
    const buffer = Buffer.allocUnsafe(MEDIA_IO_CHUNK_BYTES);
    let position = 0;
    try {
      while (position < opened.sizeBytes) {
        const length = Math.min(buffer.length, opened.sizeBytes - position);
        const { bytesRead } = await opened.handle.read(buffer, 0, length, position);
        if (bytesRead === 0) {
          fail('OBJECT_CORRUPT', 'The sermon recording object ended while being read.');
        }
        position += bytesRead;
        yield Buffer.from(buffer.subarray(0, bytesRead));
      }
      const after = await opened.handle.stat();
      if (!statIdentityMatches(opened.stats, after)) {
        fail('OBJECT_CORRUPT', 'The sermon recording object changed while being read.');
      }
    } finally {
      await opened.handle.close().catch(() => {});
    }
  }
}

module.exports = {
  DEFAULT_MAX_MEDIA_BYTES,
  LocalSermonMediaStore,
  LocalSermonMediaStoreError,
  MEDIA_IO_CHUNK_BYTES
};
