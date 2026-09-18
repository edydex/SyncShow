'use strict';

const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const { Readable } = require('stream');
const { TextDecoder } = require('util');
const zlib = require('zlib');

const {
  atomicWriteFile,
  ensureConfinedDirectory,
  ensurePrivateDirectory,
  fsyncDirectory,
  readFileNoFollow,
  withExclusiveFileLock
} = require('../project/StorageSafety');

const MAX_PDF_BYTES = 64 * 1024 * 1024;
const MAX_DOCX_BYTES = 64 * 1024 * 1024;
const MAX_PPTX_BYTES = 128 * 1024 * 1024;
const MAX_TEXT_BYTES = 8 * 1024 * 1024;
const MAX_OBJECT_BYTES = Math.max(MAX_PDF_BYTES, MAX_DOCX_BYTES, MAX_PPTX_BYTES);
const MAX_OOXML_ENTRIES = 10_000;
const MAX_OOXML_ENTRY_BYTES = 128 * 1024 * 1024;
const MAX_OOXML_EXPANDED_BYTES = 256 * 1024 * 1024;
const MAX_XML_PART_BYTES = 16 * 1024 * 1024;
const MAX_SOURCE_LANGUAGES = 8;
const MAX_MAINTENANCE_OBJECTS = 100_000;
const MAX_MAINTENANCE_OBJECT_BYTES = 1024 * 1024 * 1024 * 1024;

const OBJECT_ID_PATTERN = /^sha256:([a-f0-9]{64})$/;
const OBJECT_DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const OBJECT_PREFIX_PATTERN = /^[a-f0-9]{2}$/;
const SOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const LANGUAGE_PATTERN = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/;
const SOURCE_KINDS = new Set(['manuscript', 'slide-notes', 'transcript', 'other']);
const ZIP_LOCAL_FILE = 0x04034b50;
const ZIP_CENTRAL_FILE = 0x02014b50;
const ZIP_END = 0x06054b50;
const ZIP_METHOD_STORE = 0;
const ZIP_METHOD_DEFLATE = 8;
const ZIP_ENCRYPTED_FLAGS = 0x0001 | 0x0020 | 0x0040 | 0x2000;

const SOURCE_TYPES = Object.freeze({
  '.pdf': Object.freeze({
    format: 'pdf',
    mediaType: 'application/pdf',
    maximumBytes: MAX_PDF_BYTES,
    defaultKind: 'manuscript'
  }),
  '.docx': Object.freeze({
    format: 'docx',
    mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    maximumBytes: MAX_DOCX_BYTES,
    defaultKind: 'manuscript'
  }),
  '.pptx': Object.freeze({
    format: 'pptx',
    mediaType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    maximumBytes: MAX_PPTX_BYTES,
    defaultKind: 'slide-notes'
  }),
  '.txt': Object.freeze({
    format: 'text',
    mediaType: 'text/plain',
    maximumBytes: MAX_TEXT_BYTES,
    defaultKind: 'manuscript'
  }),
  '.md': Object.freeze({
    format: 'text',
    mediaType: 'text/markdown',
    maximumBytes: MAX_TEXT_BYTES,
    defaultKind: 'manuscript'
  }),
  '.markdown': Object.freeze({
    format: 'text',
    mediaType: 'text/markdown',
    maximumBytes: MAX_TEXT_BYTES,
    defaultKind: 'manuscript'
  })
});

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    }
    table[index] = value >>> 0;
  }
  return table;
})();

class LocalSermonSourceStoreError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'LocalSermonSourceStoreError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new LocalSermonSourceStoreError(code, message, details);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function maintenanceCapacity(value, fallback, maximum, label) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${label} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

function updateCrc32(value, buffer) {
  for (const byte of buffer) value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return value >>> 0;
}

function boundedText(value, field, maximum, { required = false } = {}) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string') fail('INVALID_SOURCE_METADATA', `${field} must be text.`);
  const normalized = value.trim().normalize('NFC');
  if (required && !normalized) fail('INVALID_SOURCE_METADATA', `${field} is required.`);
  if (normalized.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(normalized)) {
    fail('INVALID_SOURCE_METADATA', `${field} contains unsupported or excessive text.`);
  }
  return normalized;
}

function boundedFileName(sourcePath) {
  const fileName = path.basename(sourcePath).trim().normalize('NFC');
  if (!fileName
    || fileName === '.'
    || fileName === '..'
    || fileName.length > 255
    || fileName.includes('/')
    || fileName.includes('\\')
    || /^[A-Za-z]:/.test(fileName)
    || /[\u0000-\u001f\u007f]/u.test(fileName)) {
    fail('INVALID_SOURCE_METADATA', 'The selected source has an unsupported file name.');
  }
  return fileName;
}

function boundedFileNameOverride(value) {
  const fileName = boundedText(value, 'Source fileName', 255, { required: true });
  if (
    fileName !== path.basename(fileName)
    || fileName.includes('/')
    || fileName.includes('\\')
    || /^[A-Za-z]:/.test(fileName)
    || fileName === '.'
    || fileName === '..'
  ) {
    fail('INVALID_SOURCE_METADATA', 'Source fileName must be a file name, not a path.');
  }
  return fileName;
}

function normalizeTimestamp(value, field) {
  if (value === undefined || value === null || value === '') return null;
  const normalized = boundedText(value, field, 40, { required: true });
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(normalized)
    || !Number.isFinite(Date.parse(normalized))) {
    fail('INVALID_SOURCE_METADATA', `${field} must be an ISO-8601 UTC timestamp.`);
  }
  return new Date(normalized).toISOString();
}

function normalizeLanguages(value) {
  const rawLanguages = value === undefined || value === null
    ? ['und']
    : Array.isArray(value)
      ? value
      : [value];
  if (rawLanguages.length < 1 || rawLanguages.length > MAX_SOURCE_LANGUAGES) {
    fail(
      'INVALID_SOURCE_METADATA',
      `Source languages must include between 1 and ${MAX_SOURCE_LANGUAGES} language tags.`
    );
  }
  const languages = [...new Set(rawLanguages.map((value, index) => {
    const language = boundedText(value, `Source language ${index + 1}`, 35, {
      required: true
    }).toLowerCase();
    if (!LANGUAGE_PATTERN.test(language)) {
      fail(
        'INVALID_SOURCE_METADATA',
        'Source languages must use BCP-47-style tags such as en or ru.'
      );
    }
    return language;
  }))].sort();
  if (languages.length === 0) {
    fail('INVALID_SOURCE_METADATA', 'At least one source language is required.');
  }
  return languages;
}

function normalizeMetadata(options, sourceType, digest) {
  const sourceId = options.id === undefined
    ? `source-${digest}`
    : boundedText(options.id, 'Source id', 128, { required: true });
  if (!SOURCE_ID_PATTERN.test(sourceId)) {
    fail('INVALID_SOURCE_METADATA', 'Source id contains unsupported characters.');
  }
  const kind = options.kind === undefined ? sourceType.defaultKind : options.kind;
  if (!SOURCE_KINDS.has(kind)) {
    fail('INVALID_SOURCE_METADATA', 'Source kind is unsupported.');
  }
  const languages = normalizeLanguages(options.languages ?? options.language ?? 'und');
  const rawProvenance = options.provenance === undefined || options.provenance === null
    ? {}
    : options.provenance;
  if (!rawProvenance || typeof rawProvenance !== 'object' || Array.isArray(rawProvenance)) {
    fail('INVALID_SOURCE_METADATA', 'Source provenance must be an object.');
  }
  for (const key of ['path', 'filePath', 'localPath', 'absolutePath']) {
    if (Object.prototype.hasOwnProperty.call(rawProvenance, key)) {
      fail('LOCAL_PATH_NOT_ALLOWED', 'Source provenance must not persist a machine-local path.');
    }
  }
  return {
    id: sourceId,
    kind,
    languages,
    provenance: {
      providedBy: boundedText(rawProvenance.providedBy, 'Source providedBy', 200),
      receivedAt: normalizeTimestamp(rawProvenance.receivedAt, 'Source receivedAt'),
      sourceSystem: boundedText(rawProvenance.sourceSystem, 'Source sourceSystem', 100),
      externalId: boundedText(rawProvenance.externalId, 'Source externalId', 300)
    }
  };
}

function sourceTypeForPath(sourcePath) {
  const extension = path.extname(sourcePath).toLowerCase();
  const sourceType = SOURCE_TYPES[extension];
  if (!sourceType) {
    fail(
      'UNSUPPORTED_SOURCE_TYPE',
      'Sermon sources must be PDF, DOCX, PPTX, UTF-8 text, or Markdown files.'
    );
  }
  return sourceType;
}

function decodeUtf8(buffer, label) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch (_error) {
    fail('SOURCE_TYPE_MISMATCH', `${label} is not valid UTF-8 text.`);
  }
}

function validateText(buffer) {
  const text = decodeUtf8(buffer, 'The selected source');
  if (!text.replace(/^\ufeff/u, '').trim()) fail('EMPTY_SOURCE', 'The selected source is empty.');
  if (/[\u0000\u0001-\u0008\u000b\u000e-\u001f]/u.test(text)) {
    fail('SOURCE_TYPE_MISMATCH', 'The selected text source contains binary control bytes.');
  }
}

function normalizePastedText(value) {
  if (typeof value !== 'string') {
    fail('INVALID_SOURCE_METADATA', 'Pasted sermon text must be text.');
  }
  const text = value.replace(/\r\n?/gu, '\n').normalize('NFC');
  let hasUnpairedSurrogate = false;
  for (const character of text) {
    const codePoint = character.codePointAt(0);
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
      hasUnpairedSurrogate = true;
      break;
    }
  }
  if (
    hasUnpairedSurrogate
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(text)
  ) {
    fail(
      'SOURCE_TYPE_MISMATCH',
      'Pasted sermon text contains an unsupported Unicode code unit or control character.'
    );
  }
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length > MAX_TEXT_BYTES) {
    fail('SOURCE_TOO_LARGE', 'Pasted sermon text exceeds the safe text limit.');
  }
  validateText(buffer);
  return { text, buffer, digest: sha256(buffer) };
}

function validatePdf(buffer) {
  if (buffer.length < 8
    || !/^%PDF-(?:1\.[0-9]|2\.0)[\r\n]/.test(buffer.subarray(0, 9).toString('ascii'))) {
    fail('SOURCE_TYPE_MISMATCH', 'The selected .pdf file does not have a PDF header.');
  }
  if (buffer.length < 32) fail('CORRUPT_SOURCE', 'The selected PDF is incomplete.');
  const tailOffset = Math.max(0, buffer.length - 65_536);
  const tail = buffer.subarray(tailOffset).toString('latin1');
  const endMatch = /startxref[\t\r\n ]+(\d+)[\t\r\n ]+%%EOF[\t\r\n ]*$/.exec(tail);
  if (!endMatch) fail('CORRUPT_SOURCE', 'The selected PDF is incomplete or has no final cross-reference.');
  const crossReferenceOffset = Number(endMatch[1]);
  if (!Number.isSafeInteger(crossReferenceOffset)
    || crossReferenceOffset < 9
    || crossReferenceOffset >= buffer.length) {
    fail('CORRUPT_SOURCE', 'The selected PDF has an invalid cross-reference offset.');
  }
  const crossReference = buffer
    .subarray(crossReferenceOffset, Math.min(buffer.length, crossReferenceOffset + 80))
    .toString('latin1');
  if (!/^(?:xref\b|\d+[\t ]+\d+[\t ]+obj\b)/.test(crossReference)) {
    fail('CORRUPT_SOURCE', 'The selected PDF cross-reference target is invalid.');
  }
}

function safeZipEntryName(name) {
  if (typeof name !== 'string'
    || name.length < 1
    || name.length > 512
    || name.includes('\\')
    || name.includes('\0')
    || name.startsWith('/')
    || /^[A-Za-z]:/.test(name)
    || /[\u0000-\u001f\u007f]/u.test(name)) {
    return false;
  }
  const withoutTrailingSlash = name.endsWith('/') ? name.slice(0, -1) : name;
  if (!withoutTrailingSlash) return false;
  return withoutTrailingSlash.split('/').every(part => part && part !== '.' && part !== '..');
}

function assertReadable(buffer, offset, length, label) {
  if (!Number.isSafeInteger(offset)
    || !Number.isSafeInteger(length)
    || offset < 0
    || length < 0
    || offset + length > buffer.length) {
    fail('CORRUPT_SOURCE', `${label} is truncated.`);
  }
}

function inspectZipStructure(buffer) {
  if (buffer.length < 22 || buffer.readUInt32LE(0) !== ZIP_LOCAL_FILE) {
    fail('SOURCE_TYPE_MISMATCH', 'The selected Office file is not an OOXML ZIP container.');
  }
  let endOffset = -1;
  const minimumOffset = Math.max(0, buffer.length - 22 - 0xffff);
  for (let offset = buffer.length - 22; offset >= minimumOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== ZIP_END) continue;
    const commentLength = buffer.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === buffer.length) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0) fail('CORRUPT_SOURCE', 'The Office ZIP directory is missing.');
  assertReadable(buffer, endOffset, 22, 'The Office ZIP end record');

  const diskNumber = buffer.readUInt16LE(endOffset + 4);
  const centralDisk = buffer.readUInt16LE(endOffset + 6);
  const entriesOnDisk = buffer.readUInt16LE(endOffset + 8);
  const entryCount = buffer.readUInt16LE(endOffset + 10);
  const centralSize = buffer.readUInt32LE(endOffset + 12);
  const centralOffset = buffer.readUInt32LE(endOffset + 16);
  if (diskNumber !== 0
    || centralDisk !== 0
    || entriesOnDisk !== entryCount
    || entryCount < 1
    || entryCount > MAX_OOXML_ENTRIES
    || entryCount === 0xffff
    || centralSize === 0xffffffff
    || centralOffset === 0xffffffff
    || centralOffset + centralSize !== endOffset) {
    fail('CORRUPT_SOURCE', 'The Office file has an unsupported or inconsistent ZIP directory.');
  }

  const entries = new Map();
  let cursor = centralOffset;
  let declaredExpandedBytes = 0;
  for (let index = 0; index < entryCount; index += 1) {
    assertReadable(buffer, cursor, 46, `Office ZIP entry ${index + 1}`);
    if (buffer.readUInt32LE(cursor) !== ZIP_CENTRAL_FILE) {
      fail('CORRUPT_SOURCE', `Office ZIP entry ${index + 1} is invalid.`);
    }
    const versionMadeBy = buffer.readUInt16LE(cursor + 4);
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const expectedCrc32 = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const diskStart = buffer.readUInt16LE(cursor + 34);
    const externalAttributes = buffer.readUInt32LE(cursor + 38);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const recordLength = 46 + nameLength + extraLength + commentLength;
    assertReadable(buffer, cursor, recordLength, `Office ZIP entry ${index + 1}`);
    const nameBytes = buffer.subarray(cursor + 46, cursor + 46 + nameLength);
    const name = nameBytes.toString('utf8');
    const hostSystem = versionMadeBy >>> 8;
    const unixFileType = hostSystem === 3 ? ((externalAttributes >>> 16) & 0o170000) : 0;
    const dosDirectory = (externalAttributes & 0x10) !== 0;
    const isDirectory = name.endsWith('/');
    if (!safeZipEntryName(name)
      || !Buffer.from(name, 'utf8').equals(nameBytes)
      || entries.has(name)
      || diskStart !== 0
      || compressedSize === 0xffffffff
      || uncompressedSize === 0xffffffff
      || (flags & ZIP_ENCRYPTED_FLAGS) !== 0
      || ![ZIP_METHOD_STORE, ZIP_METHOD_DEFLATE].includes(method)
      || unixFileType === 0o120000
      || (dosDirectory && !isDirectory)
      || (unixFileType !== 0 && ![0o100000, 0o040000].includes(unixFileType))
      || (isDirectory && (compressedSize !== 0 || uncompressedSize !== 0))
      || (!isDirectory && uncompressedSize > MAX_OOXML_ENTRY_BYTES)) {
      fail('CORRUPT_SOURCE', `Office ZIP entry ${index + 1} is unsafe or unsupported.`);
    }

    assertReadable(buffer, localOffset, 30, `Office ZIP local entry ${index + 1}`);
    if (buffer.readUInt32LE(localOffset) !== ZIP_LOCAL_FILE) {
      fail('CORRUPT_SOURCE', `Office ZIP local entry ${index + 1} is invalid.`);
    }
    const localFlags = buffer.readUInt16LE(localOffset + 6);
    const localMethod = buffer.readUInt16LE(localOffset + 8);
    const localCrc32 = buffer.readUInt32LE(localOffset + 14);
    const localCompressedSize = buffer.readUInt32LE(localOffset + 18);
    const localUncompressedSize = buffer.readUInt32LE(localOffset + 22);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const localRecordLength = 30 + localNameLength + localExtraLength;
    assertReadable(buffer, localOffset, localRecordLength, `Office ZIP local entry ${index + 1}`);
    const localName = buffer.subarray(
      localOffset + 30,
      localOffset + 30 + localNameLength
    );
    const dataOffset = localOffset + localRecordLength;
    const usesDataDescriptor = (flags & 0x0008) !== 0;
    if (localFlags !== flags
      || localMethod !== method
      || !localName.equals(nameBytes)
      || (!usesDataDescriptor
        && (localCrc32 !== expectedCrc32
          || localCompressedSize !== compressedSize
          || localUncompressedSize !== uncompressedSize))
      || (usesDataDescriptor
        && ((localCrc32 !== 0 && localCrc32 !== expectedCrc32)
          || (localCompressedSize !== 0 && localCompressedSize !== compressedSize)
          || (localUncompressedSize !== 0 && localUncompressedSize !== uncompressedSize)))
      || dataOffset + compressedSize > centralOffset) {
      fail('CORRUPT_SOURCE', `Office ZIP local entry ${index + 1} is inconsistent.`);
    }

    declaredExpandedBytes += uncompressedSize;
    if (declaredExpandedBytes > MAX_OOXML_EXPANDED_BYTES) {
      fail('SOURCE_TOO_LARGE', 'The Office file expands beyond the safe import limit.');
    }
    entries.set(name, {
      compressedSize,
      crc32: expectedCrc32,
      dataOffset,
      isDirectory,
      method,
      uncompressedSize
    });
    cursor += recordLength;
  }
  if (cursor !== endOffset) fail('CORRUPT_SOURCE', 'The Office ZIP directory size is inconsistent.');
  return entries;
}

async function inspectExpandedZipEntry(
  archive,
  metadata,
  observed,
  { capture = false, captureLimit = MAX_XML_PART_BYTES } = {}
) {
  if (metadata.isDirectory) return null;
  const compressed = archive.subarray(
    metadata.dataOffset,
    metadata.dataOffset + metadata.compressedSize
  );
  const chunks = capture ? [] : null;
  let entryBytes = 0;
  let crc = 0xffffffff;

  const observe = chunk => {
    entryBytes += chunk.length;
    observed.totalBytes += chunk.length;
    if (entryBytes > MAX_OOXML_ENTRY_BYTES
      || observed.totalBytes > MAX_OOXML_EXPANDED_BYTES
      || (capture && entryBytes > captureLimit)) {
      fail('SOURCE_TOO_LARGE', 'The Office file expands beyond the safe import limit.');
    }
    crc = updateCrc32(crc, chunk);
    if (capture) chunks.push(Buffer.from(chunk));
  };

  if (metadata.method === ZIP_METHOD_STORE) {
    observe(compressed);
  } else {
    const inflater = zlib.createInflateRaw();
    try {
      for await (const chunk of Readable.from([compressed]).pipe(inflater)) observe(chunk);
    } catch (error) {
      inflater.destroy();
      if (error instanceof LocalSermonSourceStoreError) throw error;
      fail('CORRUPT_SOURCE', 'An Office ZIP entry could not be safely decompressed.');
    }
  }

  if (entryBytes !== metadata.uncompressedSize
    || ((crc ^ 0xffffffff) >>> 0) !== metadata.crc32) {
    fail('CORRUPT_SOURCE', 'An Office ZIP entry failed its integrity check.');
  }
  return capture ? Buffer.concat(chunks, entryBytes) : null;
}

function readValidatedXmlPart(parts, name) {
  const buffer = parts.get(name);
  if (!buffer) fail('SOURCE_TYPE_MISMATCH', 'The Office file is missing a required XML part.');
  const source = decodeUtf8(buffer, 'A required Office XML part');
  if (/<!DOCTYPE|<!ENTITY/i.test(source)) {
    fail('CORRUPT_SOURCE', 'A required Office XML part contains an unsafe declaration.');
  }
  return source;
}

async function validateOoxml(buffer, format) {
  const entries = inspectZipStructure(buffer);
  const specification = format === 'docx'
    ? {
        mainPart: 'word/document.xml',
        mainMarker: /<(?:[A-Za-z0-9_.-]+:)?document(?:[\t\r\n />])/,
        relationshipTarget: /Target=["']\/?word\/document\.xml["']/,
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'
      }
    : {
        mainPart: 'ppt/presentation.xml',
        mainMarker: /<(?:[A-Za-z0-9_.-]+:)?presentation(?:[\t\r\n />])/,
        relationshipTarget: /Target=["']\/?ppt\/presentation\.xml["']/,
        contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml'
      };
  const requiredNames = new Set([
    '[Content_Types].xml',
    '_rels/.rels',
    specification.mainPart
  ]);
  for (const name of requiredNames) {
    const metadata = entries.get(name);
    if (!metadata
      || metadata.isDirectory
      || metadata.uncompressedSize < 1
      || metadata.uncompressedSize > MAX_XML_PART_BYTES) {
      fail('SOURCE_TYPE_MISMATCH', 'The Office file is missing a required XML part.');
    }
  }

  const observed = { totalBytes: 0 };
  const xmlParts = new Map();
  for (const [name, metadata] of entries) {
    if (metadata.isDirectory) continue;
    const capture = requiredNames.has(name);
    const expanded = await inspectExpandedZipEntry(buffer, metadata, observed, { capture });
    if (capture) xmlParts.set(name, expanded);
  }

  const contentTypes = readValidatedXmlPart(xmlParts, '[Content_Types].xml');
  const relationships = readValidatedXmlPart(xmlParts, '_rels/.rels');
  if (!contentTypes.includes(specification.contentType)
    || !specification.relationshipTarget.test(relationships)) {
    fail('SOURCE_TYPE_MISMATCH', `The selected file is not a valid ${format.toUpperCase()} document.`);
  }
  const mainPart = readValidatedXmlPart(xmlParts, specification.mainPart);
  if (!specification.mainMarker.test(mainPart)) {
    fail('CORRUPT_SOURCE', `The ${format.toUpperCase()} main document part is invalid.`);
  }
}

async function validateSourceBuffer(buffer, sourceType) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 1) {
    fail('EMPTY_SOURCE', 'The selected source is empty.');
  }
  if (buffer.length > sourceType.maximumBytes) {
    fail('SOURCE_TOO_LARGE', `The selected source exceeds the ${sourceType.maximumBytes}-byte limit.`);
  }
  if (sourceType.format === 'pdf') validatePdf(buffer);
  else if (sourceType.format === 'text') validateText(buffer);
  else await validateOoxml(buffer, sourceType.format);
}

async function readValidatedSourceFile(options = {}) {
  if (typeof options.sourcePath !== 'string' || !path.isAbsolute(options.sourcePath)) {
    fail('INVALID_SOURCE_PATH', 'Choose a sermon source through SyncShow.');
  }
  const sourcePath = path.resolve(options.sourcePath);
  const sourceType = sourceTypeForPath(sourcePath);
  let buffer;
  try {
    ({ buffer } = await readFileNoFollow(sourcePath, sourceType.maximumBytes));
  } catch (error) {
    if (/larger than/.test(error.message)) {
      fail('SOURCE_TOO_LARGE', `The selected source exceeds the safe ${sourceType.format.toUpperCase()} limit.`);
    }
    fail('UNSAFE_SOURCE', 'The selected source is not a stable regular file.');
  }
  await validateSourceBuffer(buffer, sourceType);
  return {
    sourcePath,
    sourceType,
    buffer,
    digest: sha256(buffer)
  };
}

class LocalSermonSourceStore {
  constructor(options = {}) {
    if (typeof options.rootPath !== 'string' || !path.isAbsolute(options.rootPath)) {
      throw new TypeError('LocalSermonSourceStore requires an absolute rootPath');
    }
    this.rootPath = path.resolve(options.rootPath);
    this.unlinkObject = options.unlinkObject || fs.unlink;
    this.randomUUID = options.randomUUID || crypto.randomUUID;
    if (typeof this.unlinkObject !== 'function' || typeof this.randomUUID !== 'function') {
      throw new TypeError('LocalSermonSourceStore maintenance dependencies must be functions');
    }
  }

  async initialize() {
    try {
      this.rootPath = await ensurePrivateDirectory(this.rootPath);
      await ensureConfinedDirectory(this.rootPath, path.join(this.rootPath, 'objects'));
    } catch (error) {
      if (error instanceof LocalSermonSourceStoreError) throw error;
      fail('STORE_UNAVAILABLE', 'The local sermon source store is unavailable.');
    }
    return this;
  }

  _digestFromObjectId(objectId) {
    const match = OBJECT_ID_PATTERN.exec(objectId || '');
    if (!match) fail('INVALID_OBJECT_ID', 'The sermon source object id is invalid.');
    return match[1];
  }

  _objectPath(digest) {
    return path.join(this.rootPath, 'objects', digest.slice(0, 2), digest);
  }

  async _readVerifiedObject(objectId, expectedSize = null) {
    await this.initialize();
    const digest = this._digestFromObjectId(objectId);
    const objectPath = this._objectPath(digest);
    let buffer;
    try {
      await ensureConfinedDirectory(this.rootPath, path.dirname(objectPath));
      ({ buffer } = await readFileNoFollow(objectPath, MAX_OBJECT_BYTES));
    } catch (error) {
      if (error instanceof LocalSermonSourceStoreError) throw error;
      if (error.code === 'ENOENT') fail('OBJECT_NOT_FOUND', 'The sermon source object is unavailable.');
      fail('OBJECT_CORRUPT', 'The sermon source object is unsafe or unavailable.');
    }
    if ((expectedSize !== null && buffer.length !== expectedSize) || sha256(buffer) !== digest) {
      fail('OBJECT_CORRUPT', 'The sermon source object failed its content-addressed integrity check.');
    }
    return buffer;
  }

  async importFile(options = {}) {
    await this.initialize();
    const { sourcePath, sourceType, buffer, digest } = await readValidatedSourceFile(options);
    const objectId = `sha256:${digest}`;
    const metadata = normalizeMetadata(options, sourceType, digest);
    const fileName = options.fileName === undefined
      ? boundedFileName(sourcePath)
      : boundedFileNameOverride(options.fileName);
    if (sourceTypeForPath(fileName).mediaType !== sourceType.mediaType) {
      fail(
        'INVALID_SOURCE_METADATA',
        'Source fileName must use the same supported file type as the selected source.'
      );
    }
    const source = deepFreeze({
      id: metadata.id,
      kind: metadata.kind,
      fileName,
      mediaType: sourceType.mediaType,
      languages: metadata.languages,
      sha256: digest,
      sizeBytes: buffer.length,
      provenance: metadata.provenance
    });
    const objectPath = this._objectPath(digest);
    try {
      await ensureConfinedDirectory(this.rootPath, path.dirname(objectPath));
      await withExclusiveFileLock(path.join(this.rootPath, '.source-write-lock'), async () => {
        try {
          await this._readVerifiedObject(objectId, buffer.length);
        } catch (error) {
          if (error.code !== 'OBJECT_NOT_FOUND') throw error;
          await atomicWriteFile(objectPath, buffer, {
            rootPath: this.rootPath,
            maximumBytes: sourceType.maximumBytes,
            mode: 0o600
          });
          await this._readVerifiedObject(objectId, buffer.length);
        }
      });
    } catch (error) {
      if (error instanceof LocalSermonSourceStoreError) throw error;
      if (error.code === 'WRITE_LOCKED') {
        fail('WRITE_LOCKED', 'The sermon source store is already being updated.');
      }
      fail('STORE_UNAVAILABLE', 'The local sermon source store could not save the source.');
    }
    return deepFreeze({ objectId, source });
  }

  async importText(options = {}) {
    await this.initialize();
    const sourceType = SOURCE_TYPES['.txt'];
    const { text, buffer, digest } = normalizePastedText(options.text);
    const objectId = `sha256:${digest}`;
    const metadata = normalizeMetadata(options, sourceType, digest);
    const fileName = options.fileName === undefined
      ? 'pasted-sermon-text.txt'
      : boundedFileNameOverride(options.fileName);
    if (sourceTypeForPath(fileName).mediaType !== sourceType.mediaType) {
      fail(
        'INVALID_SOURCE_METADATA',
        'Pasted sermon text fileName must use a supported plain-text extension.'
      );
    }
    const source = deepFreeze({
      id: metadata.id,
      kind: metadata.kind,
      fileName,
      mediaType: sourceType.mediaType,
      languages: metadata.languages,
      sha256: digest,
      sizeBytes: buffer.length,
      provenance: metadata.provenance
    });
    const objectPath = this._objectPath(digest);
    try {
      await ensureConfinedDirectory(this.rootPath, path.dirname(objectPath));
      await withExclusiveFileLock(path.join(this.rootPath, '.source-write-lock'), async () => {
        try {
          await this._readVerifiedObject(objectId, buffer.length);
        } catch (error) {
          if (error.code !== 'OBJECT_NOT_FOUND') throw error;
          await atomicWriteFile(objectPath, buffer, {
            rootPath: this.rootPath,
            maximumBytes: sourceType.maximumBytes,
            mode: 0o600
          });
          await this._readVerifiedObject(objectId, buffer.length);
        }
      });
    } catch (error) {
      if (error instanceof LocalSermonSourceStoreError) throw error;
      if (error.code === 'WRITE_LOCKED') {
        fail('WRITE_LOCKED', 'The sermon source store is already being updated.');
      }
      fail('STORE_UNAVAILABLE', 'The local sermon source store could not save pasted text.');
    }
    return deepFreeze({ objectId, source, text });
  }

  async inspectFile(options = {}) {
    const { sourcePath, sourceType, buffer, digest } = await readValidatedSourceFile(options);
    return deepFreeze({
      fileName: boundedFileName(sourcePath),
      mediaType: sourceType.mediaType,
      sha256: digest,
      sizeBytes: buffer.length,
      defaultKind: sourceType.defaultKind
    });
  }

  async checkObject(objectId, options = {}) {
    const expectedSize = options.sizeBytes === undefined ? null : options.sizeBytes;
    if (expectedSize !== null
      && (!Number.isSafeInteger(expectedSize) || expectedSize < 1 || expectedSize > MAX_OBJECT_BYTES)) {
      fail('INVALID_SOURCE_METADATA', 'Expected sermon source size is invalid.');
    }
    const buffer = await this._readVerifiedObject(objectId, expectedSize);
    return deepFreeze({
      objectId,
      sha256: this._digestFromObjectId(objectId),
      sizeBytes: buffer.length
    });
  }

  async readObject(objectId, options = {}) {
    const checked = await this.checkObject(objectId, options);
    return this._readVerifiedObject(checked.objectId, checked.sizeBytes);
  }

  async checkSource(source) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
      fail('INVALID_SOURCE_METADATA', 'Sermon source metadata is required.');
    }
    if (!/^[a-f0-9]{64}$/.test(source.sha256 || '')
      || !Number.isSafeInteger(source.sizeBytes)
      || source.sizeBytes < 1) {
      fail('INVALID_SOURCE_METADATA', 'Sermon source checksum or size is invalid.');
    }
    const fileName = boundedText(
      source.fileName,
      'Source fileName',
      255,
      { required: true }
    );
    if (fileName.includes('/')
      || fileName.includes('\\')
      || /^[A-Za-z]:/.test(fileName)
      || fileName === '.'
      || fileName === '..') {
      fail('INVALID_SOURCE_METADATA', 'Sermon source fileName must be a file name, not a path.');
    }
    const sourceType = sourceTypeForPath(fileName);
    if (source.mediaType !== sourceType.mediaType) {
      fail('SOURCE_TYPE_MISMATCH', 'Sermon source media type does not match its file name.');
    }
    const objectId = `sha256:${source.sha256}`;
    const buffer = await this._readVerifiedObject(objectId, source.sizeBytes);
    await validateSourceBuffer(buffer, sourceType);
    return deepFreeze({
      objectId,
      sha256: source.sha256,
      sizeBytes: source.sizeBytes,
      mediaType: source.mediaType
    });
  }

  async readSource(source) {
    const checked = await this.checkSource(source);
    return this._readVerifiedObject(checked.objectId, checked.sizeBytes);
  }

  async collectVerifiedObjects(options = {}) {
    const maximumObjects = maintenanceCapacity(
      options.maximumObjects,
      MAX_MAINTENANCE_OBJECTS,
      MAX_MAINTENANCE_OBJECTS,
      'maximumObjects'
    );
    const maximumBytes = maintenanceCapacity(
      options.maximumBytes,
      MAX_MAINTENANCE_OBJECT_BYTES,
      MAX_MAINTENANCE_OBJECT_BYTES,
      'maximumBytes'
    );
    await this.initialize();
    return withExclusiveFileLock(path.join(this.rootPath, '.source-write-lock'), async () => {
      const objectsRoot = path.join(this.rootPath, 'objects');
      let prefixes;
      try {
        prefixes = await fs.readdir(objectsRoot, { withFileTypes: true });
      } catch (_error) {
        fail('OBJECT_STORE_AMBIGUOUS', 'The sermon source object inventory could not be validated.');
      }
      prefixes.sort((left, right) => left.name.localeCompare(right.name));

      const objects = [];
      let totalBytes = 0;
      for (const prefix of prefixes) {
        if (
          !OBJECT_PREFIX_PATTERN.test(prefix.name)
          || !prefix.isDirectory()
          || prefix.isSymbolicLink?.()
        ) {
          fail('OBJECT_STORE_AMBIGUOUS', 'The sermon source object inventory contains an unsupported entry.');
        }
        const prefixPath = path.join(objectsRoot, prefix.name);
        try {
          await ensureConfinedDirectory(this.rootPath, prefixPath);
        } catch (_error) {
          fail('OBJECT_STORE_AMBIGUOUS', 'The sermon source object inventory contains an unsafe directory.');
        }
        let entries;
        try {
          entries = await fs.readdir(prefixPath, { withFileTypes: true });
        } catch (_error) {
          fail('OBJECT_STORE_AMBIGUOUS', 'The sermon source object inventory could not be validated.');
        }
        if (entries.length > maximumObjects - objects.length) {
          fail('OBJECT_SCAN_LIMIT', 'The sermon source object inventory exceeds the bounded maintenance scan.');
        }
        entries.sort((left, right) => left.name.localeCompare(right.name));
        for (const entry of entries) {
          if (
            !OBJECT_DIGEST_PATTERN.test(entry.name)
            || entry.name.slice(0, 2) !== prefix.name
            || !entry.isFile()
            || entry.isSymbolicLink?.()
          ) {
            fail('OBJECT_STORE_AMBIGUOUS', 'The sermon source object inventory contains an unsupported entry.');
          }
          const objectPath = path.join(prefixPath, entry.name);
          let stats;
          try {
            stats = await fs.lstat(objectPath);
          } catch (_error) {
            fail('OBJECT_STORE_AMBIGUOUS', 'The sermon source object inventory changed during validation.');
          }
          if (
            !stats.isFile()
            || stats.isSymbolicLink()
            || stats.size < 1
            || stats.size > MAX_OBJECT_BYTES
            || (process.platform !== 'win32' && (stats.mode & 0o077) !== 0)
          ) {
            fail('OBJECT_STORE_AMBIGUOUS', 'The sermon source object inventory contains an unsafe object.');
          }
          if (objects.length + 1 > maximumObjects || totalBytes + stats.size > maximumBytes) {
            fail('OBJECT_SCAN_LIMIT', 'The sermon source object inventory exceeds the bounded maintenance scan.');
          }
          const objectId = `sha256:${entry.name}`;
          await this._readVerifiedObject(objectId, stats.size);
          objects.push(deepFreeze({
            objectId,
            sha256: entry.name,
            sizeBytes: stats.size
          }));
          totalBytes += stats.size;
        }
      }
      return deepFreeze({
        objects,
        objectCount: objects.length,
        totalBytes
      });
    });
  }

  async deleteVerifiedObject(objectId, options = {}) {
    const expectedSize = options.sizeBytes === undefined ? null : options.sizeBytes;
    if (
      expectedSize !== null
      && (!Number.isSafeInteger(expectedSize) || expectedSize < 1 || expectedSize > MAX_OBJECT_BYTES)
    ) {
      fail('INVALID_SOURCE_METADATA', 'Expected sermon source size is invalid.');
    }
    await this.initialize();
    return withExclusiveFileLock(path.join(this.rootPath, '.source-write-lock'), async () => {
      const digest = this._digestFromObjectId(objectId);
      const buffer = await this._readVerifiedObject(objectId, expectedSize);
      const objectPath = this._objectPath(digest);
      const directoryPath = path.dirname(objectPath);
      const token = this.randomUUID();
      if (typeof token !== 'string' || !/^[A-Za-z0-9-]{1,80}$/.test(token)) {
        fail('OBJECT_DELETE_FAILED', 'The sermon source object could not be isolated safely.');
      }
      const tombstonePath = path.join(directoryPath, `.gc-${digest}-${token}`);
      const restoreTombstone = async () => {
        try {
          await fs.lstat(objectPath);
          throw new Error('The canonical object name was unexpectedly recreated.');
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        await fs.rename(tombstonePath, objectPath);
        await fsyncDirectory(directoryPath);
        await this._readVerifiedObject(objectId, buffer.length);
      };
      let isolated = false;
      try {
        await fs.rename(objectPath, tombstonePath);
        isolated = true;
        await fsyncDirectory(directoryPath);
      } catch (_error) {
        if (isolated) {
          try {
            await restoreTombstone();
          } catch (_rollbackError) {
            fail('OBJECT_DELETE_ROLLBACK_FAILED', 'The sermon source object deletion rollback requires recovery.');
          }
        }
        fail('OBJECT_DELETE_FAILED', 'The sermon source object could not be isolated safely.');
      }

      try {
        const { buffer: tombstone } = await readFileNoFollow(tombstonePath, MAX_OBJECT_BYTES);
        if (!tombstone.equals(buffer) || sha256(tombstone) !== digest) {
          throw new Error('Tombstone integrity check failed');
        }
        await this.unlinkObject(tombstonePath);
      } catch (_error) {
        try {
          await restoreTombstone();
        } catch (_rollbackError) {
          fail('OBJECT_DELETE_ROLLBACK_FAILED', 'The sermon source object deletion rollback requires recovery.');
        }
        fail('OBJECT_DELETE_FAILED', 'The sermon source object was preserved because deletion did not finish safely.');
      }
      try {
        await fsyncDirectory(directoryPath);
      } catch (_error) {
        if (process.platform !== 'win32') {
          fail('OBJECT_DELETE_DURABILITY_FAILED', 'The sermon source object was removed but durability could not be confirmed.');
        }
      }
      return deepFreeze({ objectId, sha256: digest, sizeBytes: buffer.length });
    });
  }
}

module.exports = {
  LocalSermonSourceStore,
  LocalSermonSourceStoreError,
  MAX_DOCX_BYTES,
  MAX_MAINTENANCE_OBJECTS,
  MAX_PDF_BYTES,
  MAX_PPTX_BYTES,
  MAX_TEXT_BYTES,
  SOURCE_TYPES,
  inspectZipStructure,
  validateSourceBuffer
};
