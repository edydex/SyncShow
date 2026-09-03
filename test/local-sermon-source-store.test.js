'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { once } = require('events');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const JSZip = require('jszip');
const zlib = require('zlib');

const {
  LocalSermonSourceStore,
  LocalSermonSourceStoreError,
  MAX_TEXT_BYTES
} = require('../src/services/sermon/LocalSermonSourceStore');
const {
  SERMON_KIND,
  SERMON_SCHEMA_VERSION,
  normalizeSermonDocument
} = require('../src/services/sermon/SermonDocument');

async function tempDirectory(t, prefix = 'syncshow-sermon-source-') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return fs.realpath(directory);
}

function expectStoreCode(code, forbiddenText = []) {
  return error => {
    assert.ok(error instanceof LocalSermonSourceStoreError);
    assert.equal(error.code, code);
    for (const text of forbiddenText) assert.equal(error.message.includes(text), false);
    return true;
  };
}

async function storeErrorCode(operation) {
  let caught = null;
  try {
    await operation();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof LocalSermonSourceStoreError);
  return caught.code;
}

function minimalPdf(version = '1.4') {
  const body = Buffer.from(
    `%PDF-${version}\n`
      + '1 0 obj\n'
      + '<< /Type /Catalog >>\n'
      + 'endobj\n',
    'ascii'
  );
  const xrefOffset = body.length;
  const ending = Buffer.from(
    'xref\n'
      + '0 2\n'
      + '0000000000 65535 f \n'
      + '0000000009 00000 n \n'
      + 'trailer\n'
      + '<< /Size 2 /Root 1 0 R >>\n'
      + `startxref\n${xrefOffset}\n`
      + '%%EOF\n',
    'ascii'
  );
  return Buffer.concat([body, ending]);
}

const TEST_CRC32_TABLE = (() => {
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

function testCrc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value = TEST_CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function buildZip(entries) {
  const localRecords = [];
  const centralRecords = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const compressed = entry.compressed || entry.bytes;
    const method = entry.method || 0;
    const declaredSize = entry.declaredSize === undefined
      ? entry.bytes.length
      : entry.declaredSize;
    const checksum = entry.crc32 === undefined ? testCrc32(entry.bytes) : entry.crc32;
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(declaredSize, 22);
    localHeader.writeUInt16LE(name.length, 26);
    const localRecord = Buffer.concat([localHeader, name, compressed]);
    localRecords.push(localRecord);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(declaredSize, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt32LE(localOffset, 42);
    centralRecords.push(Buffer.concat([centralHeader, name]));
    localOffset += localRecord.length;
  }
  const centralDirectory = Buffer.concat(centralRecords);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localRecords, centralDirectory, end]);
}

async function deflateRepeatedZeroes(totalBytes) {
  const compressor = zlib.createDeflateRaw({ level: 9 });
  const chunks = [];
  compressor.on('data', chunk => chunks.push(chunk));
  const ended = once(compressor, 'end');
  const block = Buffer.alloc(1024 * 1024);
  let written = 0;
  while (written < totalBytes) {
    const chunk = block.subarray(0, Math.min(block.length, totalBytes - written));
    if (!compressor.write(chunk)) await once(compressor, 'drain');
    written += chunk.length;
  }
  compressor.end();
  await ended;
  return Buffer.concat(chunks);
}

async function minimalOoxml(format) {
  const isDocx = format === 'docx';
  const mainPart = isDocx ? 'word/document.xml' : 'ppt/presentation.xml';
  const contentType = isDocx
    ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'
    : 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml';
  const mainXml = isDocx
    ? '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="urn:test"><w:body/></w:document>'
    : '<?xml version="1.0" encoding="UTF-8"?><p:presentation xmlns:p="urn:test"></p:presentation>';
  const zip = new JSZip();
  const options = { createFolders: false, date: new Date(Date.UTC(1980, 0, 1)) };
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8"?>'
      + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + `<Override PartName="/${mainPart}" ContentType="${contentType}"/>`
      + '</Types>',
    options
  );
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + `<Relationship Id="rId1" Target="${mainPart}" `
      + 'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"/>'
      + '</Relationships>',
    options
  );
  zip.file(mainPart, mainXml, options);
  return zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
    platform: 'UNIX',
    streamFiles: false
  });
}

function draftSermonWithSource(source) {
  return {
    schemaVersion: SERMON_SCHEMA_VERSION,
    kind: SERMON_KIND,
    id: 'sermon-source-store-test',
    titles: { en: 'Stored source test' },
    defaultLanguage: 'en',
    speaker: { id: null, name: 'Pastor' },
    serviceDate: '2026-07-26',
    series: null,
    outline: [],
    sources: [source],
    references: [],
    media: [],
    publication: {
      status: 'draft',
      visibility: 'private',
      publishedAt: null,
      canonicalUrl: null
    }
  };
}

test('source store requires and enforces an absolute private root', async t => {
  assert.throws(
    () => new LocalSermonSourceStore({ rootPath: 'relative-store' }),
    /requires an absolute rootPath/
  );
  const parent = await tempDirectory(t);
  const rootPath = path.join(parent, 'store');
  await fs.mkdir(rootPath, { mode: 0o777 });
  if (process.platform !== 'win32') await fs.chmod(rootPath, 0o777);

  const store = await new LocalSermonSourceStore({ rootPath }).initialize();
  assert.equal(store.rootPath, await fs.realpath(rootPath));
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(rootPath)).mode & 0o077, 0);
    assert.equal((await fs.stat(path.join(rootPath, 'objects'))).mode & 0o077, 0);
  }
});

test('initialization failures are typed and do not expose the local storage path', async t => {
  const parent = await tempDirectory(t);
  const rootPath = path.join(parent, 'not-a-directory');
  await fs.writeFile(rootPath, 'occupied');
  const store = new LocalSermonSourceStore({ rootPath });

  await assert.rejects(
    store.initialize(),
    expectStoreCode('STORE_UNAVAILABLE', [rootPath, parent])
  );
});

test('PDF import is content-addressed, idempotent, path-free, and independent of the selected file', async t => {
  const rootPath = await tempDirectory(t);
  const sourceRoot = await tempDirectory(t, 'syncshow-sermon-selected-');
  const sourcePath = path.join(sourceRoot, '07-26 Prayer.pdf');
  const bytes = minimalPdf();
  await fs.writeFile(sourcePath, bytes);
  const store = new LocalSermonSourceStore({ rootPath });
  const options = {
    sourcePath,
    kind: 'manuscript',
    languages: ['ru', 'en', 'ru'],
    provenance: {
      providedBy: 'Pastor',
      receivedAt: '2026-07-24T18:30:00Z',
      sourceSystem: 'pastor-email',
      externalId: 'message-1'
    }
  };

  const first = await store.importFile(options);
  const second = await store.importFile(options);
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  assert.deepEqual(second, first);
  assert.equal(first.objectId, `sha256:${digest}`);
  assert.deepEqual(first.source, {
    id: `source-${digest}`,
    kind: 'manuscript',
    fileName: '07-26 Prayer.pdf',
    mediaType: 'application/pdf',
    languages: ['en', 'ru'],
    sha256: digest,
    sizeBytes: bytes.length,
    provenance: {
      providedBy: 'Pastor',
      receivedAt: '2026-07-24T18:30:00.000Z',
      sourceSystem: 'pastor-email',
      externalId: 'message-1'
    }
  });
  assert.doesNotMatch(JSON.stringify(first), new RegExp(sourceRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.deepEqual(normalizeSermonDocument(draftSermonWithSource(first.source)).sources, [
    first.source
  ]);

  const objectDirectory = path.join(rootPath, 'objects', digest.slice(0, 2));
  assert.deepEqual(await fs.readdir(objectDirectory), [digest]);
  await fs.unlink(sourcePath);
  assert.deepEqual(await store.readSource(first.source), bytes);
  assert.deepEqual(await store.checkSource(first.source), {
    objectId: first.objectId,
    sha256: digest,
    sizeBytes: bytes.length,
    mediaType: 'application/pdf'
  });
});

test('PDF 2.0 sources are accepted and verified', async t => {
  const rootPath = await tempDirectory(t);
  const sourceRoot = await tempDirectory(t, 'syncshow-sermon-pdf2-');
  const sourcePath = path.join(sourceRoot, 'sermon-pdf-2.pdf');
  const bytes = minimalPdf('2.0');
  await fs.writeFile(sourcePath, bytes);

  const imported = await new LocalSermonSourceStore({ rootPath }).importFile({ sourcePath });
  assert.equal(imported.source.mediaType, 'application/pdf');
  assert.deepEqual(
    await new LocalSermonSourceStore({ rootPath }).readSource(imported.source),
    bytes
  );
});

test('pasted sermon text is canonicalized, content-addressed, and retained as a private source', async t => {
  const rootPath = await tempDirectory(t, 'syncshow-sermon-paste-');
  const store = new LocalSermonSourceStore({ rootPath });
  const imported = await store.importText({
    id: 'source-pasted-manuscript-en',
    text: 'Prayer in the church.\r\n\r\nGod gives strength.\r',
    fileName: 'pasted-manuscript-en.txt',
    kind: 'manuscript',
    languages: ['en'],
    provenance: {
      providedBy: 'Pastor',
      receivedAt: '2026-07-30T12:00:00Z',
      sourceSystem: 'syncshow-manual-paste',
      externalId: 'sermon-1:manuscript:en'
    }
  });
  const canonicalText = 'Prayer in the church.\n\nGod gives strength.\n';
  const bytes = Buffer.from(canonicalText, 'utf8');
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');

  assert.equal(imported.text, canonicalText);
  assert.equal(imported.objectId, `sha256:${digest}`);
  assert.deepEqual(imported.source, {
    id: 'source-pasted-manuscript-en',
    kind: 'manuscript',
    fileName: 'pasted-manuscript-en.txt',
    mediaType: 'text/plain',
    languages: ['en'],
    sha256: digest,
    sizeBytes: bytes.length,
    provenance: {
      providedBy: 'Pastor',
      receivedAt: '2026-07-30T12:00:00.000Z',
      sourceSystem: 'syncshow-manual-paste',
      externalId: 'sermon-1:manuscript:en'
    }
  });
  assert.deepEqual(await store.readSource(imported.source), bytes);
  assert.deepEqual(
    await store.importText({
      id: 'source-pasted-manuscript-en',
      text: canonicalText,
      fileName: 'pasted-manuscript-en.txt',
      kind: 'manuscript',
      languages: ['en'],
      provenance: imported.source.provenance
    }),
    imported
  );
});

test('pasted sermon text rejects empty, oversized, unsafe, and disguised metadata', async t => {
  const rootPath = await tempDirectory(t, 'syncshow-sermon-paste-invalid-');
  const store = new LocalSermonSourceStore({ rootPath });

  await assert.rejects(
    store.importText({ text: ' \r\n\t ' }),
    expectStoreCode('EMPTY_SOURCE')
  );
  await assert.rejects(
    store.importText({ text: `Unsafe\u0000text` }),
    expectStoreCode('SOURCE_TYPE_MISMATCH')
  );
  await assert.rejects(
    store.importText({ text: 'x'.repeat(MAX_TEXT_BYTES + 1) }),
    expectStoreCode('SOURCE_TOO_LARGE')
  );
  await assert.rejects(
    store.importText({
      text: 'Reviewed text',
      fileName: '/private/pasted-manuscript.txt'
    }),
    expectStoreCode('INVALID_SOURCE_METADATA', [rootPath])
  );
  await assert.rejects(
    store.importText({
      text: 'Reviewed text',
      fileName: 'pasted-manuscript.pdf'
    }),
    expectStoreCode('INVALID_SOURCE_METADATA')
  );
});

test('DOCX, PPTX, UTF-8 text, and Markdown are verified and stored with compatible metadata', async t => {
  const rootPath = await tempDirectory(t);
  const sourceRoot = await tempDirectory(t, 'syncshow-sermon-formats-');
  const fixtures = [{
    fileName: 'manuscript.docx',
    bytes: await minimalOoxml('docx'),
    kind: 'manuscript',
    mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  }, {
    fileName: 'sermon-slides.pptx',
    bytes: await minimalOoxml('pptx'),
    kind: 'slide-notes',
    mediaType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  }, {
    fileName: 'notes.txt',
    bytes: Buffer.from('Ephesians 3:14-21\nPrayer that transforms the church.\n', 'utf8'),
    kind: 'manuscript',
    mediaType: 'text/plain'
  }, {
    fileName: 'outline.md',
    bytes: Buffer.from('# Sermon outline\n\n- Foundation\n- Content\n', 'utf8'),
    kind: 'manuscript',
    mediaType: 'text/markdown'
  }];
  const store = new LocalSermonSourceStore({ rootPath });

  for (const fixture of fixtures) {
    const sourcePath = path.join(sourceRoot, fixture.fileName);
    await fs.writeFile(sourcePath, fixture.bytes);
    const imported = await store.importFile({ sourcePath, language: 'ru' });
    assert.equal(imported.source.kind, fixture.kind);
    assert.equal(imported.source.mediaType, fixture.mediaType);
    assert.deepEqual(imported.source.languages, ['ru']);
    assert.deepEqual(await store.readObject(imported.objectId, {
      sizeBytes: fixture.bytes.length
    }), fixture.bytes);
    assert.equal((await store.checkSource(imported.source)).objectId, imported.objectId);
  }
});

test('a trusted display filename preserves the original deck name without changing its type', async t => {
  const rootPath = await tempDirectory(t);
  const sourceRoot = await tempDirectory(t, 'syncshow-sermon-pinned-deck-');
  const sourcePath = path.join(sourceRoot, 'english-a1b2c3.pptx');
  await fs.writeFile(sourcePath, await minimalOoxml('pptx'));
  const store = new LocalSermonSourceStore({ rootPath });

  const imported = await store.importFile({
    sourcePath,
    fileName: '07-26-2026 Service ENG.pptx',
    languages: ['en']
  });
  assert.equal(imported.source.fileName, '07-26-2026 Service ENG.pptx');
  assert.equal(imported.source.mediaType,
    'application/vnd.openxmlformats-officedocument.presentationml.presentation');

  await assert.rejects(
    store.importFile({ sourcePath, fileName: '/private/Service ENG.pptx' }),
    expectStoreCode('INVALID_SOURCE_METADATA', [sourceRoot])
  );
  await assert.rejects(
    store.importFile({ sourcePath, fileName: 'Service ENG.pdf' }),
    expectStoreCode('INVALID_SOURCE_METADATA', [sourceRoot])
  );
});

test('inspection previews verified PDF and PPTX sources without creating source objects', async t => {
  const rootPath = await tempDirectory(t);
  const sourceRoot = await tempDirectory(t, 'syncshow-sermon-inspection-');
  const pdfPath = path.join(sourceRoot, '07-26 Prayer.pdf');
  const pptxPath = path.join(sourceRoot, '07-26 Service.pptx');
  const pdfBytes = minimalPdf();
  const pptxBytes = await minimalOoxml('pptx');
  await fs.writeFile(pdfPath, pdfBytes);
  await fs.writeFile(pptxPath, pptxBytes);
  const store = new LocalSermonSourceStore({ rootPath });

  const pdf = await store.inspectFile({ sourcePath: pdfPath });
  const pptx = await store.inspectFile({ sourcePath: pptxPath });

  assert.deepEqual(pdf, {
    fileName: '07-26 Prayer.pdf',
    mediaType: 'application/pdf',
    sha256: crypto.createHash('sha256').update(pdfBytes).digest('hex'),
    sizeBytes: pdfBytes.length,
    defaultKind: 'manuscript'
  });
  assert.deepEqual(pptx, {
    fileName: '07-26 Service.pptx',
    mediaType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    sha256: crypto.createHash('sha256').update(pptxBytes).digest('hex'),
    sizeBytes: pptxBytes.length,
    defaultKind: 'slide-notes'
  });
  assert.equal(Object.isFrozen(pdf), true);
  assert.equal(Object.isFrozen(pptx), true);
  assert.doesNotMatch(
    JSON.stringify({ pdf, pptx }),
    new RegExp(sourceRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  );
  assert.deepEqual(await fs.readdir(rootPath), []);
});

test('inspection rejects changed, unsafe, and invalid selections with the same typed failures as import', async t => {
  const rootPath = await tempDirectory(t);
  const sourceRoot = await tempDirectory(t, 'syncshow-sermon-inspection-failures-');
  const store = new LocalSermonSourceStore({ rootPath });
  const invalidPath = path.join(sourceRoot, 'notes.rtf');
  const corruptPath = path.join(sourceRoot, 'truncated.pdf');
  await fs.writeFile(invalidPath, 'not a supported sermon source');
  await fs.writeFile(corruptPath, Buffer.from('%PDF-1.7\n1 0 obj\n%%EOF\n'));

  const cases = [{ sourcePath: 'relative.pdf', code: 'INVALID_SOURCE_PATH' }, {
    sourcePath: invalidPath,
    code: 'UNSUPPORTED_SOURCE_TYPE'
  }, {
    sourcePath: corruptPath,
    code: 'CORRUPT_SOURCE'
  }];
  if (process.platform !== 'win32') {
    const stablePath = path.join(sourceRoot, 'stable.md');
    const symlinkPath = path.join(sourceRoot, 'linked.md');
    await fs.writeFile(stablePath, '# Stable sermon source\n');
    await fs.symlink(stablePath, symlinkPath);
    cases.push({ sourcePath: symlinkPath, code: 'UNSAFE_SOURCE' });
  }

  for (const fixture of cases) {
    const inspected = await storeErrorCode(() => store.inspectFile({ sourcePath: fixture.sourcePath }));
    const imported = await storeErrorCode(() => store.importFile({ sourcePath: fixture.sourcePath }));
    assert.equal(inspected, fixture.code);
    assert.equal(imported, fixture.code);
  }

  async function rejectChangedSelection(method) {
    const sourcePath = path.join(sourceRoot, `changed-${method}.md`);
    const replacementPath = path.join(sourceRoot, `replacement-${method}.md`);
    await fs.writeFile(sourcePath, '# Original sermon source\n');
    await fs.writeFile(replacementPath, '# Replaced sermon source with different length\n');
    const originalOpen = fs.open;
    let replaced = false;
    fs.open = async (...args) => {
      if (!replaced && args[0] === sourcePath) {
        replaced = true;
        await fs.rename(replacementPath, sourcePath);
      }
      return originalOpen(...args);
    };
    try {
      return await storeErrorCode(() => store[method]({ sourcePath }));
    } finally {
      fs.open = originalOpen;
    }
  }

  assert.equal(await rejectChangedSelection('inspectFile'), 'UNSAFE_SOURCE');
  assert.equal(await rejectChangedSelection('importFile'), 'UNSAFE_SOURCE');
});

test('OOXML expansion is bounded by observed bytes even when ZIP metadata declares a small size', async t => {
  const rootPath = await tempDirectory(t);
  const sourceRoot = await tempDirectory(t, 'syncshow-sermon-zip-bomb-');
  const sourcePath = path.join(sourceRoot, 'forged-size.docx');
  const contentTypes = Buffer.from(
    '<?xml version="1.0" encoding="UTF-8"?>'
      + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Override PartName="/word/document.xml" '
      + 'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
      + '</Types>',
    'utf8'
  );
  const relationships = Buffer.from(
    '<?xml version="1.0" encoding="UTF-8"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Target="word/document.xml" '
      + 'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"/>'
      + '</Relationships>',
    'utf8'
  );
  const mainPart = Buffer.from(
    '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="urn:test"><w:body/></w:document>',
    'utf8'
  );
  const compressedBomb = await deflateRepeatedZeroes((128 * 1024 * 1024) + 1);
  const archive = buildZip([{
    name: 'word/observed-expansion.bin',
    bytes: Buffer.alloc(0),
    compressed: compressedBomb,
    method: 8,
    declaredSize: 1,
    crc32: 0
  }, {
    name: '[Content_Types].xml',
    bytes: contentTypes
  }, {
    name: '_rels/.rels',
    bytes: relationships
  }, {
    name: 'word/document.xml',
    bytes: mainPart
  }]);
  await fs.writeFile(sourcePath, archive);

  await assert.rejects(
    new LocalSermonSourceStore({ rootPath }).importFile({ sourcePath }),
    expectStoreCode('SOURCE_TOO_LARGE', [sourcePath, sourceRoot, rootPath])
  );
});

test('unsupported, empty, oversized, binary-text, type-mismatched, and corrupt sources fail closed', async t => {
  const rootPath = await tempDirectory(t);
  const sourceRoot = await tempDirectory(t, 'syncshow-sermon-invalid-');
  const store = new LocalSermonSourceStore({ rootPath });

  await assert.rejects(
    store.importFile({ sourcePath: 'relative.pdf' }),
    expectStoreCode('INVALID_SOURCE_PATH')
  );

  await assert.rejects(
    store.checkSource({
      fileName: 'C:sermon.txt',
      mediaType: 'text/plain',
      sha256: 'a'.repeat(64),
      sizeBytes: 1
    }),
    expectStoreCode('INVALID_SOURCE_METADATA')
  );

  if (process.platform !== 'win32') {
    const drivePrefixedPath = path.join(sourceRoot, 'C:sermon.txt');
    await fs.writeFile(drivePrefixedPath, 'Sermon text');
    await assert.rejects(
      store.importFile({ sourcePath: drivePrefixedPath }),
      expectStoreCode('INVALID_SOURCE_METADATA')
    );
  }

  const unsupportedPath = path.join(sourceRoot, 'notes.rtf');
  await fs.writeFile(unsupportedPath, 'pretend rich text');
  await assert.rejects(
    store.importFile({ sourcePath: unsupportedPath }),
    expectStoreCode('UNSUPPORTED_SOURCE_TYPE')
  );

  const emptyPath = path.join(sourceRoot, 'empty.md');
  await fs.writeFile(emptyPath, '');
  await assert.rejects(store.importFile({ sourcePath: emptyPath }), expectStoreCode('EMPTY_SOURCE'));

  const whitespacePath = path.join(sourceRoot, 'whitespace.txt');
  await fs.writeFile(whitespacePath, ' \n\t ');
  await assert.rejects(
    store.importFile({ sourcePath: whitespacePath }),
    expectStoreCode('EMPTY_SOURCE')
  );

  const binaryTextPath = path.join(sourceRoot, 'binary.txt');
  await fs.writeFile(binaryTextPath, Buffer.from([0xff, 0xfe, 0x00, 0x00]));
  await assert.rejects(
    store.importFile({ sourcePath: binaryTextPath }),
    expectStoreCode('SOURCE_TYPE_MISMATCH')
  );

  const oversizedPath = path.join(sourceRoot, 'oversized.md');
  await fs.writeFile(oversizedPath, Buffer.alloc(MAX_TEXT_BYTES + 1, 0x61));
  await assert.rejects(
    store.importFile({ sourcePath: oversizedPath }),
    expectStoreCode('SOURCE_TOO_LARGE')
  );

  const renamedZipPath = path.join(sourceRoot, 'renamed.pdf');
  await fs.writeFile(renamedZipPath, await minimalOoxml('docx'));
  await assert.rejects(
    store.importFile({ sourcePath: renamedZipPath }),
    expectStoreCode('SOURCE_TYPE_MISMATCH')
  );

  const wrongOfficeTypePath = path.join(sourceRoot, 'presentation.docx');
  await fs.writeFile(wrongOfficeTypePath, await minimalOoxml('pptx'));
  await assert.rejects(
    store.importFile({ sourcePath: wrongOfficeTypePath }),
    expectStoreCode('SOURCE_TYPE_MISMATCH')
  );

  const corruptPdfPath = path.join(sourceRoot, 'truncated.pdf');
  await fs.writeFile(corruptPdfPath, Buffer.from('%PDF-1.7\n1 0 obj\n%%EOF\n'));
  await assert.rejects(
    store.importFile({ sourcePath: corruptPdfPath }),
    expectStoreCode('CORRUPT_SOURCE')
  );

  const completeDocx = await minimalOoxml('docx');
  const corruptDocxPath = path.join(sourceRoot, 'truncated.docx');
  await fs.writeFile(corruptDocxPath, completeDocx.subarray(0, completeDocx.length - 4));
  await assert.rejects(
    store.importFile({ sourcePath: corruptDocxPath }),
    expectStoreCode('CORRUPT_SOURCE')
  );
});

test('source symlinks and tampered stored objects are rejected without replacing evidence', async t => {
  const rootPath = await tempDirectory(t);
  const sourceRoot = await tempDirectory(t, 'syncshow-sermon-tamper-');
  const sourcePath = path.join(sourceRoot, 'notes.md');
  const bytes = Buffer.from('# Original sermon notes\n', 'utf8');
  await fs.writeFile(sourcePath, bytes);
  const store = new LocalSermonSourceStore({ rootPath });

  if (process.platform !== 'win32') {
    const linkPath = path.join(sourceRoot, 'linked.md');
    await fs.symlink(sourcePath, linkPath);
    await assert.rejects(
      store.importFile({ sourcePath: linkPath }),
      expectStoreCode('UNSAFE_SOURCE', [linkPath, sourcePath, sourceRoot])
    );
  }

  const imported = await store.importFile({ sourcePath });
  const objectPath = path.join(
    rootPath,
    'objects',
    imported.source.sha256.slice(0, 2),
    imported.source.sha256
  );
  const tampered = Buffer.from(bytes);
  tampered[tampered.length - 2] ^= 0x01;
  await fs.writeFile(objectPath, tampered);

  await assert.rejects(
    store.checkObject(imported.objectId, { sizeBytes: bytes.length }),
    expectStoreCode('OBJECT_CORRUPT')
  );
  await assert.rejects(
    store.readSource(imported.source),
    expectStoreCode('OBJECT_CORRUPT')
  );
  await assert.rejects(
    store.importFile({ sourcePath }),
    expectStoreCode('OBJECT_CORRUPT')
  );
  assert.deepEqual(await fs.readFile(objectPath), tampered);
});

test('an intermediate object-prefix symlink is rejected before stored bytes are read', async t => {
  if (process.platform === 'win32') return;
  const rootPath = await tempDirectory(t);
  const sourceRoot = await tempDirectory(t, 'syncshow-sermon-prefix-link-');
  const sourcePath = path.join(sourceRoot, 'notes.md');
  await fs.writeFile(sourcePath, '# Original notes\n');
  const store = new LocalSermonSourceStore({ rootPath });
  const imported = await store.importFile({ sourcePath });
  const prefixPath = path.join(rootPath, 'objects', imported.source.sha256.slice(0, 2));
  const displacedPath = path.join(sourceRoot, 'displaced-object-prefix');
  await fs.rename(prefixPath, displacedPath);
  await fs.symlink(displacedPath, prefixPath, 'dir');

  await assert.rejects(
    store.readSource(imported.source),
    expectStoreCode('OBJECT_CORRUPT', [
      prefixPath,
      displacedPath,
      sourceRoot,
      rootPath
    ])
  );
});

test('provenance cannot smuggle local paths into a sermon source record', async t => {
  const rootPath = await tempDirectory(t);
  const sourceRoot = await tempDirectory(t, 'syncshow-sermon-provenance-');
  const sourcePath = path.join(sourceRoot, 'notes.txt');
  await fs.writeFile(sourcePath, 'Source text');
  const store = new LocalSermonSourceStore({ rootPath });

  await assert.rejects(
    store.importFile({
      sourcePath,
      provenance: { localPath: '/private/pastor/notes.txt' }
    }),
    expectStoreCode('LOCAL_PATH_NOT_ALLOWED')
  );
});
