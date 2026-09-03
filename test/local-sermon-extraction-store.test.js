'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const {
  LocalSermonExtractionStore,
  LocalSermonExtractionStoreError
} = require('../src/services/sermon/LocalSermonExtractionStore');

const BASE_SERMON_REVISION = 'b'.repeat(64);
const RESULTING_SERMON_REVISION = 'c'.repeat(64);
const RESULTING_PROJECT_REVISION = 'd'.repeat(64);

async function tempDirectory(t, prefix = 'syncshow-sermon-extractions-') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return fs.realpath(directory);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function extraction({
  sourceId = 'source-manuscript',
  sourceSha256 = 'a'.repeat(64),
  sourceKind = 'manuscript',
  extractorId = 'syncshow-deterministic-source-extractor',
  extractorVersion = 1,
  outlineSuffix = ''
} = {}) {
  const text = 'I. Foundation\nII. Content\nRomans 5:5-8';
  const referenceStart = text.indexOf('Romans');
  return {
    schemaVersion: 1,
    kind: 'syncshow-sermon-source-extraction-proposal',
    extractor: {
      id: extractorId,
      version: extractorVersion
    },
    source: {
      id: sourceId,
      sha256: sourceSha256,
      kind: sourceKind,
      languages: ['ru', 'en'],
      mediaType: 'text/plain'
    },
    units: [{
      id: 'document-1',
      kind: 'document',
      ordinal: 1,
      label: 'Document section 1',
      text,
      truncated: false
    }],
    textPreview: text,
    suggestionScope: {
      strategy: 'whole-source',
      startUnitId: 'document-1',
      endUnitId: 'document-1',
      startOrdinal: 1,
      endOrdinal: 1
    },
    outlineSuggestions: [{
      id: `outline-i${outlineSuffix}`,
      level: 1,
      marker: 'I',
      parentId: null,
      parentSuggestionId: null,
      suggestedKind: 'section',
      titles: { ru: 'Основание', en: 'Foundation' },
      rawText: 'I. Foundation',
      sourceUnitIds: ['document-1'],
      sourceUnitIdsTruncated: false,
      occurrenceCount: 1
    }, {
      id: `outline-ii${outlineSuffix}`,
      level: 1,
      marker: 'II',
      parentId: null,
      parentSuggestionId: null,
      suggestedKind: 'section',
      titles: { en: 'Content', ru: 'Содержание' },
      rawText: 'II. Content',
      sourceUnitIds: ['document-1'],
      sourceUnitIdsTruncated: false,
      occurrenceCount: 1
    }],
    scriptureReferenceSuggestions: [{
      id: `reference-romans-5-5-8${outlineSuffix}`,
      rawText: 'Romans 5:5-8',
      language: 'en',
      bookHint: 'Rom',
      unitId: 'document-1',
      startOffset: referenceStart,
      endOffset: referenceStart + 'Romans 5:5-8'.length,
      sourceUnitIds: ['document-1'],
      sourceUnitIdsTruncated: false,
      occurrenceCount: 1
    }],
    truncated: {
      units: false,
      text: false,
      preview: false,
      outlineSuggestions: false,
      scriptureReferences: false
    }
  };
}

function reverseObjectKeys(value) {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([key, child]) => [key, reverseObjectKeys(child)])
  );
}

function bindingFor(saved) {
  return {
    sermonId: saved.binding.sermonId,
    baseSermonRevisionId: saved.binding.baseSermonRevisionId,
    sourceId: saved.binding.sourceId,
    sourceSha256: saved.binding.sourceSha256,
    sourceKind: saved.binding.sourceKind,
    extractorId: saved.binding.extractorId,
    extractorVersion: saved.binding.extractorVersion
  };
}

function receiptFor(snapshotHash, overrides = {}) {
  return {
    snapshotHash,
    projectId: 'service-2026-07-26',
    resultingSermonRevisionId: RESULTING_SERMON_REVISION,
    resultingProjectRevisionId: RESULTING_PROJECT_REVISION,
    reviewedAt: '2026-07-28T12:00:00.000Z',
    outlineSuggestionIds: ['outline:outline-ii', 'outline:outline-i'],
    referenceSuggestionIds: ['reference:reference-romans-5-5-8'],
    ...overrides
  };
}

function reviewedLookup(saved, overrides = {}) {
  return {
    sermonId: saved.binding.sermonId,
    resultingSermonRevisionId: RESULTING_SERMON_REVISION,
    sourceId: saved.binding.sourceId,
    sourceSha256: saved.binding.sourceSha256,
    projectId: 'service-2026-07-26',
    ...overrides
  };
}

function expectStoreCode(code, forbiddenText = []) {
  return error => {
    assert.ok(error instanceof LocalSermonExtractionStoreError);
    assert.equal(error.code, code);
    for (const text of forbiddenText) {
      assert.doesNotMatch(`${error.message}\n${JSON.stringify(error.details)}`, new RegExp(
        text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      ));
    }
    return true;
  };
}

async function jsonFiles(root) {
  const found = [];
  async function visit(directory) {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) await visit(candidate);
      else if (entry.isFile() && entry.name.endsWith('.json')) found.push(candidate);
    }
  }
  await visit(root);
  return found.sort();
}

async function onlyJsonFile(root) {
  const files = await jsonFiles(root);
  assert.equal(files.length, 1);
  return files[0];
}

async function savedSnapshot(store, options = {}) {
  return store.saveSnapshot({
    sermonId: options.sermonId || 'sermon-2026-07-26',
    baseSermonRevisionId: options.baseSermonRevisionId || BASE_SERMON_REVISION,
    extraction: options.extraction || extraction()
  });
}

test('store requires an absolute root and repairs every structural directory to owner-only', async t => {
  assert.throws(
    () => new LocalSermonExtractionStore({ rootPath: 'relative-extractions' }),
    /requires an absolute rootPath/
  );
  assert.throws(
    () => new LocalSermonExtractionStore({
      rootPath: path.resolve('invalid-extraction-capacity'),
      maximumReviewReceiptsPerSnapshot: 1_001
    }),
    /maximumReviewReceiptsPerSnapshot must be an integer between 1 and 1000/
  );
  const parent = await tempDirectory(t);
  const rootPath = path.join(parent, 'store');
  for (const directory of [
    rootPath,
    path.join(rootPath, 'snapshots'),
    path.join(rootPath, 'bindings'),
    path.join(rootPath, 'receipts'),
    path.join(rootPath, 'review-index')
  ]) {
    await fs.mkdir(directory, { recursive: true, mode: 0o777 });
    if (process.platform !== 'win32') await fs.chmod(directory, 0o777);
  }

  const store = await new LocalSermonExtractionStore({ rootPath }).initialize();
  assert.equal(store.rootPath, await fs.realpath(rootPath));
  if (process.platform !== 'win32') {
    for (const directory of [
      rootPath,
      path.join(rootPath, 'snapshots'),
      path.join(rootPath, 'bindings'),
      path.join(rootPath, 'receipts'),
      path.join(rootPath, 'review-index')
    ]) {
      assert.equal((await fs.stat(directory)).mode & 0o077, 0, directory);
    }
  }
});

test('initialization failures are typed, path-free, and root symlinks fail closed', async t => {
  const parent = await tempDirectory(t);
  const occupied = path.join(parent, 'occupied');
  await fs.writeFile(occupied, 'not a directory');
  await assert.rejects(
    new LocalSermonExtractionStore({ rootPath: occupied }).initialize(),
    expectStoreCode('STORE_UNAVAILABLE', [occupied, parent])
  );

  if (process.platform !== 'win32') {
    const target = path.join(parent, 'target');
    const linked = path.join(parent, 'linked');
    await fs.mkdir(target);
    await fs.symlink(target, linked, 'dir');
    await assert.rejects(
      new LocalSermonExtractionStore({ rootPath: linked }).initialize(),
      expectStoreCode('STORE_UNAVAILABLE', [target, linked, parent])
    );
  }
});

test('canonical snapshot bytes and hashes are deterministic, idempotent, and restart-readable', async t => {
  const firstRoot = await tempDirectory(t);
  const secondRoot = await tempDirectory(t);
  const firstStore = new LocalSermonExtractionStore({ rootPath: firstRoot });
  const secondStore = new LocalSermonExtractionStore({ rootPath: secondRoot });
  const first = await savedSnapshot(firstStore);
  const retry = await savedSnapshot(firstStore, {
    extraction: reverseObjectKeys(extraction())
  });
  const independentlySaved = await savedSnapshot(secondStore, {
    extraction: reverseObjectKeys(extraction())
  });

  assert.equal(first.unchanged, false);
  assert.equal(retry.unchanged, true);
  assert.equal(independentlySaved.unchanged, false);
  assert.equal(retry.snapshotHash, first.snapshotHash);
  assert.equal(independentlySaved.snapshotHash, first.snapshotHash);
  assert.deepEqual(retry.binding, first.binding);
  assert.deepEqual(retry.extraction, first.extraction);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.extraction.units[0]), true);

  const firstFile = await onlyJsonFile(path.join(firstRoot, 'snapshots'));
  const secondFile = await onlyJsonFile(path.join(secondRoot, 'snapshots'));
  const firstBytes = await fs.readFile(firstFile);
  const secondBytes = await fs.readFile(secondFile);
  assert.deepEqual(secondBytes, firstBytes);
  assert.equal(crypto.createHash('sha256').update(firstBytes).digest('hex'), first.snapshotHash);
  assert.equal(firstBytes[firstBytes.length - 1], 0x0a);

  const reopened = await new LocalSermonExtractionStore({
    rootPath: firstRoot
  }).readExactSnapshot(bindingFor(first));
  assert.deepEqual(reopened, {
    snapshotHash: first.snapshotHash,
    binding: first.binding,
    extraction: first.extraction
  });
  assert.equal(Object.isFrozen(reopened), true);
});

test('exact binding distinguishes sermon, base revision, source, kind, and extractor drift', async t => {
  const rootPath = await tempDirectory(t);
  const store = new LocalSermonExtractionStore({ rootPath });
  const baseline = await savedSnapshot(store);
  const sourceDrift = await savedSnapshot(store, {
    extraction: extraction({ sourceSha256: '1'.repeat(64) })
  });
  const kindDrift = await savedSnapshot(store, {
    extraction: extraction({
      sourceId: 'source-slides',
      sourceSha256: '2'.repeat(64),
      sourceKind: 'slide-notes'
    })
  });
  const toolDrift = await savedSnapshot(store, {
    extraction: extraction({ extractorVersion: 2 })
  });
  const sermonDrift = await savedSnapshot(store, {
    sermonId: 'sermon-other'
  });
  const revisionDrift = await savedSnapshot(store, {
    baseSermonRevisionId: '3'.repeat(64)
  });
  const hashes = new Set([
    baseline,
    sourceDrift,
    kindDrift,
    toolDrift,
    sermonDrift,
    revisionDrift
  ].map(item => item.snapshotHash));
  assert.equal(hashes.size, 6);

  for (const saved of [
    baseline,
    sourceDrift,
    kindDrift,
    toolDrift,
    sermonDrift,
    revisionDrift
  ]) {
    assert.equal(
      (await store.readExactSnapshot(bindingFor(saved))).snapshotHash,
      saved.snapshotHash
    );
  }
  assert.equal(await store.readExactSnapshot({
    ...bindingFor(baseline),
    sourceSha256: '4'.repeat(64)
  }), null);
});

test('immutable v1 and styled v2 payloads coexist under extractor-version bindings', async t => {
  const rootPath = await tempDirectory(t);
  const store = new LocalSermonExtractionStore({ rootPath });
  const legacyExtraction = extraction({
    sourceId: 'source-slides',
    sourceKind: 'slide-notes',
    extractorVersion: 1
  });
  legacyExtraction.source.mediaType =
    'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  legacyExtraction.units[0].kind = 'slide';

  const styledExtraction = clone(legacyExtraction);
  styledExtraction.schemaVersion = 2;
  styledExtraction.extractor.version = 2;
  const emphasisStart = styledExtraction.units[0].text.indexOf('Romans');
  styledExtraction.units[0].spans = [{
    start: emphasisStart,
    end: emphasisStart + 'Romans 5:5-8'.length,
    foreground: '#ffc000',
    weight: '700'
  }];

  const legacy = await savedSnapshot(store, { extraction: legacyExtraction });
  const styled = await savedSnapshot(store, { extraction: styledExtraction });

  assert.notEqual(styled.snapshotHash, legacy.snapshotHash);
  assert.equal(legacy.binding.extractorVersion, 1);
  assert.equal(styled.binding.extractorVersion, 2);
  assert.equal(styled.extraction.schemaVersion, 2);
  assert.deepEqual(styled.extraction.units[0].spans, styledExtraction.units[0].spans);
  assert.equal(
    (await store.readExactSnapshot(bindingFor(legacy))).snapshotHash,
    legacy.snapshotHash
  );
  assert.equal(
    (await store.readExactSnapshot(bindingFor(styled))).snapshotHash,
    styled.snapshotHash
  );

  const snapshotFiles = await jsonFiles(path.join(rootPath, 'snapshots'));
  assert.equal(snapshotFiles.length, 2);
  for (const filePath of snapshotFiles) {
    const wrapper = JSON.parse(await fs.readFile(filePath, 'utf8'));
    assert.equal(wrapper.schemaVersion, 1);
  }
});

test('same exact binding cannot be overwritten by nondeterministic evidence', async t => {
  const rootPath = await tempDirectory(t);
  const store = new LocalSermonExtractionStore({ rootPath });
  const first = await savedSnapshot(store);
  const changed = extraction();
  changed.units[0].text = changed.units[0].text.replace('Foundation', 'Changed evidence');
  changed.textPreview = changed.units[0].text;
  changed.outlineSuggestions[0].rawText = 'I. Changed evidence';
  const before = await fs.readFile(await onlyJsonFile(path.join(rootPath, 'snapshots')));

  await assert.rejects(
    savedSnapshot(store, { extraction: changed }),
    expectStoreCode('BINDING_CONFLICT', [rootPath])
  );
  assert.deepEqual(
    await fs.readFile(await onlyJsonFile(path.join(rootPath, 'snapshots'))),
    before
  );
  assert.equal((await store.readExactSnapshot(bindingFor(first))).snapshotHash, first.snapshotHash);
});

test('path fields and source-byte fields never enter a snapshot or returned binding', async t => {
  const rootPath = await tempDirectory(t);
  const store = new LocalSermonExtractionStore({ rootPath });
  const localPath = '/private/pastor/07-26-sermon.pdf';
  const cases = [
    proposal => { proposal.localPath = localPath; },
    proposal => { proposal.source.filePath = localPath; },
    proposal => { proposal.source.bytes = [37, 80, 68, 70]; },
    proposal => { proposal.units[0].sourceBytes = [1, 2, 3]; }
  ];
  for (const mutate of cases) {
    const proposal = extraction();
    mutate(proposal);
    await assert.rejects(
      savedSnapshot(store, { extraction: proposal }),
      expectStoreCode('INVALID_EXTRACTION_SNAPSHOT', [localPath, rootPath])
    );
  }
  assert.deepEqual(await jsonFiles(rootPath), []);

  const saved = await savedSnapshot(store);
  const allBytes = Buffer.concat(await Promise.all(
    (await jsonFiles(rootPath)).map(file => fs.readFile(file))
  )).toString('utf8');
  assert.doesNotMatch(allBytes, /localPath|filePath|sourceBytes|"bytes"/);
  assert.doesNotMatch(JSON.stringify(saved.binding), /\bpath\b|bytes/i);
});

test('snapshot and binding-index corruption fail closed and preserve exact evidence', async t => {
  const snapshotRoot = await tempDirectory(t);
  const snapshotStore = new LocalSermonExtractionStore({ rootPath: snapshotRoot });
  const snapshot = await savedSnapshot(snapshotStore);
  const snapshotPath = await onlyJsonFile(path.join(snapshotRoot, 'snapshots'));
  const tamperedSnapshot = Buffer.from('{"tampered":"snapshot"}\n');
  await fs.writeFile(snapshotPath, tamperedSnapshot);

  await assert.rejects(
    snapshotStore.readExactSnapshot(bindingFor(snapshot)),
    expectStoreCode('SNAPSHOT_CORRUPT', [snapshotRoot])
  );
  await assert.rejects(
    savedSnapshot(snapshotStore),
    expectStoreCode('SNAPSHOT_CORRUPT', [snapshotRoot])
  );
  assert.deepEqual(await fs.readFile(snapshotPath), tamperedSnapshot);

  const indexRoot = await tempDirectory(t);
  const indexStore = new LocalSermonExtractionStore({ rootPath: indexRoot });
  const indexed = await savedSnapshot(indexStore);
  const indexPath = await onlyJsonFile(path.join(indexRoot, 'bindings'));
  const tamperedIndex = Buffer.from('not canonical json\n');
  await fs.writeFile(indexPath, tamperedIndex);

  await assert.rejects(
    indexStore.readExactSnapshot(bindingFor(indexed)),
    expectStoreCode('BINDING_INDEX_CORRUPT', [indexRoot])
  );
  await assert.rejects(
    savedSnapshot(indexStore),
    expectStoreCode('BINDING_INDEX_CORRUPT', [indexRoot])
  );
  assert.deepEqual(await fs.readFile(indexPath), tamperedIndex);
});

test('stored snapshot symlinks and intermediate directory symlinks are never followed', async t => {
  if (process.platform === 'win32') return;
  const snapshotRoot = await tempDirectory(t);
  const outsideRoot = await tempDirectory(t, 'syncshow-extraction-outside-');
  const store = new LocalSermonExtractionStore({ rootPath: snapshotRoot });
  const saved = await savedSnapshot(store);
  const snapshotPath = await onlyJsonFile(path.join(snapshotRoot, 'snapshots'));
  const outsideFile = path.join(outsideRoot, 'outside.json');
  const original = await fs.readFile(snapshotPath);
  await fs.writeFile(outsideFile, original);
  await fs.unlink(snapshotPath);
  await fs.symlink(outsideFile, snapshotPath);

  await assert.rejects(
    store.readExactSnapshot(bindingFor(saved)),
    expectStoreCode('SNAPSHOT_CORRUPT', [outsideFile, outsideRoot, snapshotRoot])
  );
  assert.deepEqual(await fs.readFile(outsideFile), original);

  const bindingRoot = await tempDirectory(t);
  const bindingStore = await new LocalSermonExtractionStore({
    rootPath: bindingRoot
  }).initialize();
  const displaced = path.join(outsideRoot, 'displaced-bindings');
  await fs.rename(path.join(bindingRoot, 'bindings'), displaced);
  await fs.symlink(displaced, path.join(bindingRoot, 'bindings'), 'dir');
  await assert.rejects(
    savedSnapshot(bindingStore),
    expectStoreCode('STORE_UNAVAILABLE', [displaced, outsideRoot, bindingRoot])
  );
});

test('snapshot capacity is enforced without affecting exact idempotent reuse', async t => {
  const rootPath = await tempDirectory(t);
  const store = new LocalSermonExtractionStore({
    rootPath,
    maximumSnapshots: 1
  });
  const saved = await savedSnapshot(store);
  assert.equal((await savedSnapshot(store)).unchanged, true);
  await assert.rejects(
    savedSnapshot(store, {
      extraction: extraction({ sourceSha256: '5'.repeat(64) })
    }),
    expectStoreCode('SNAPSHOT_CAPACITY_REACHED')
  );
  assert.equal((await store.readExactSnapshot(bindingFor(saved))).snapshotHash, saved.snapshotHash);
});

test('an immutable snapshot orphaned before index publication is reused even at capacity', async t => {
  const rootPath = await tempDirectory(t);
  const store = new LocalSermonExtractionStore({
    rootPath,
    maximumSnapshots: 1
  });
  const first = await savedSnapshot(store);
  const bindingIndexPath = await onlyJsonFile(path.join(rootPath, 'bindings'));
  await fs.unlink(bindingIndexPath);

  assert.equal(await store.readExactSnapshot(bindingFor(first)), null);
  const recovered = await savedSnapshot(store);
  assert.equal(recovered.snapshotHash, first.snapshotHash);
  assert.equal(recovered.unchanged, false);
  assert.equal((await store.readExactSnapshot(bindingFor(first))).snapshotHash, first.snapshotHash);
  assert.equal((await jsonFiles(path.join(rootPath, 'snapshots'))).length, 1);
});

test('overly broad stored-file permissions fail closed instead of exposing private evidence', async t => {
  if (process.platform === 'win32') return;
  const rootPath = await tempDirectory(t);
  const store = new LocalSermonExtractionStore({ rootPath });
  const saved = await savedSnapshot(store);
  const snapshotPath = await onlyJsonFile(path.join(rootPath, 'snapshots'));
  await fs.chmod(snapshotPath, 0o644);

  await assert.rejects(
    store.readExactSnapshot(bindingFor(saved)),
    expectStoreCode('SNAPSHOT_CORRUPT', [rootPath])
  );
  assert.equal((await fs.stat(snapshotPath)).mode & 0o077, 0o044);
});

test('review receipts require an explicit valid snapshot-scoped envelope subset', async t => {
  const rootPath = await tempDirectory(t);
  const store = new LocalSermonExtractionStore({ rootPath });
  const saved = await savedSnapshot(store);

  await assert.rejects(
    store.saveReviewReceipt(receiptFor('9'.repeat(64))),
    expectStoreCode('SNAPSHOT_NOT_FOUND')
  );
  await assert.rejects(
    store.saveReviewReceipt(receiptFor(saved.snapshotHash, {
      outlineSuggestionIds: ['outline-i']
    })),
    expectStoreCode('INVALID_REVIEW_RECEIPT')
  );
  await assert.rejects(
    store.saveReviewReceipt(receiptFor(saved.snapshotHash, {
      outlineSuggestionIds: ['outline:reference-romans-5-5-8']
    })),
    expectStoreCode('UNKNOWN_REVIEW_SUGGESTION')
  );
  await assert.rejects(
    store.saveReviewReceipt(receiptFor(saved.snapshotHash, {
      referenceSuggestionIds: ['reference:outline-i']
    })),
    expectStoreCode('UNKNOWN_REVIEW_SUGGESTION')
  );
  await assert.rejects(
    store.saveReviewReceipt(receiptFor(saved.snapshotHash, {
      outlineSuggestionIds: [],
      referenceSuggestionIds: []
    })),
    expectStoreCode('INVALID_REVIEW_RECEIPT')
  );

  const other = await savedSnapshot(store, {
    extraction: extraction({
      sourceId: 'source-other',
      sourceSha256: '6'.repeat(64),
      outlineSuffix: '-other'
    })
  });
  await assert.rejects(
    store.saveReviewReceipt(receiptFor(saved.snapshotHash, {
      outlineSuggestionIds: ['outline:outline-i-other'],
      referenceSuggestionIds: []
    })),
    expectStoreCode('UNKNOWN_REVIEW_SUGGESTION')
  );
  assert.equal(
    (await store.saveReviewReceipt(receiptFor(other.snapshotHash, {
      outlineSuggestionIds: ['outline:outline-i-other'],
      referenceSuggestionIds: []
    }))).unchanged,
    false
  );
});

test('review receipt bytes are immutable, canonical, idempotent, and owner-only', async t => {
  const parent = await tempDirectory(t);
  const rootPath = path.join(parent, 'store');
  const store = new LocalSermonExtractionStore({ rootPath });
  const snapshot = await savedSnapshot(store);
  const first = await store.saveReviewReceipt(receiptFor(snapshot.snapshotHash));
  const retry = await store.saveReviewReceipt(receiptFor(snapshot.snapshotHash, {
    outlineSuggestionIds: ['outline:outline-i', 'outline:outline-ii']
  }));

  assert.equal(first.unchanged, false);
  assert.equal(retry.unchanged, true);
  assert.equal(retry.receiptHash, first.receiptHash);
  assert.deepEqual(retry.receipt, first.receipt);
  assert.deepEqual(first.receipt.outlineSuggestionIds, [
    'outline:outline-i',
    'outline:outline-ii'
  ]);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.receipt.outlineSuggestionIds), true);

  const receiptFiles = await jsonFiles(path.join(rootPath, 'receipts'));
  assert.equal(receiptFiles.length, 1);
  const receiptBytes = await fs.readFile(receiptFiles[0]);
  assert.equal(crypto.createHash('sha256').update(receiptBytes).digest('hex'), first.receiptHash);
  if (process.platform !== 'win32') {
    for (const file of await jsonFiles(rootPath)) {
      assert.equal((await fs.stat(file)).mode & 0o077, 0, file);
    }
    const directories = [
      rootPath,
      path.join(rootPath, 'snapshots'),
      path.join(rootPath, 'bindings'),
      path.join(rootPath, 'receipts'),
      path.join(rootPath, 'review-index'),
      path.dirname(receiptFiles[0])
    ];
    for (const directory of directories) {
      assert.equal((await fs.stat(directory)).mode & 0o077, 0, directory);
    }
  }
});

test('review status is empty before explicit receipt save and survives restart afterward', async t => {
  const rootPath = await tempDirectory(t);
  const store = new LocalSermonExtractionStore({ rootPath });
  const snapshot = await savedSnapshot(store);
  assert.deepEqual(await store.readReviewStatus({
    snapshotHash: snapshot.snapshotHash
  }), {
    snapshotHash: snapshot.snapshotHash,
    reviewed: false,
    receipts: [],
    skippedCorruptReceipts: 0
  });

  const savedReceipt = await store.saveReviewReceipt(receiptFor(snapshot.snapshotHash));
  const reopened = new LocalSermonExtractionStore({ rootPath });
  const status = await reopened.readReviewStatus({
    snapshotHash: snapshot.snapshotHash,
    projectId: 'service-2026-07-26'
  });
  assert.equal(status.reviewed, true);
  assert.equal(status.skippedCorruptReceipts, 0);
  assert.deepEqual(status.receipts, [{
    receiptHash: savedReceipt.receiptHash,
    ...savedReceipt.receipt
  }]);
  assert.equal(Object.isFrozen(status.receipts[0]), true);
  assert.equal((await reopened.readReviewStatus({
    snapshotHash: snapshot.snapshotHash,
    projectId: 'service-other'
  })).reviewed, false);
});

test('reviewed snapshot discovery is exact across restart and rejects every lookup drift', async t => {
  const rootPath = await tempDirectory(t);
  const store = new LocalSermonExtractionStore({ rootPath });
  const snapshot = await savedSnapshot(store);
  const receipt = await store.saveReviewReceipt(receiptFor(snapshot.snapshotHash));
  const reopened = new LocalSermonExtractionStore({ rootPath });

  const found = await reopened.findReviewedSnapshot(reviewedLookup(snapshot));
  assert.deepEqual(found.snapshot, {
    snapshotHash: snapshot.snapshotHash,
    binding: snapshot.binding,
    extraction: snapshot.extraction
  });
  assert.deepEqual(found.receipt, {
    receiptHash: receipt.receiptHash,
    ...receipt.receipt
  });
  assert.equal(found.reviewStatus.reviewed, true);
  assert.equal(Object.isFrozen(found), true);

  const driftCases = [{
    sermonId: 'sermon-other'
  }, {
    resultingSermonRevisionId: '7'.repeat(64)
  }, {
    sourceId: 'source-other'
  }, {
    sourceSha256: '8'.repeat(64)
  }, {
    projectId: 'service-other'
  }];
  for (const drift of driftCases) {
    assert.equal(
      await reopened.findReviewedSnapshot(reviewedLookup(snapshot, drift)),
      null
    );
  }
  assert.equal(await reopened.readExactSnapshot({
    ...bindingFor(snapshot),
    baseSermonRevisionId: RESULTING_SERMON_REVISION
  }), null);
});

test('restart rebuilds only an exact missing review index from durable receipts', async t => {
  const rootPath = await tempDirectory(t);
  const store = new LocalSermonExtractionStore({ rootPath });
  const snapshot = await savedSnapshot(store);
  const first = await store.saveReviewReceipt(receiptFor(snapshot.snapshotHash));
  const second = await store.saveReviewReceipt(receiptFor(snapshot.snapshotHash, {
    resultingProjectRevisionId: 'e'.repeat(64),
    reviewedAt: '2026-07-28T13:00:00.000Z'
  }));
  const receiptFiles = await jsonFiles(path.join(rootPath, 'receipts'));
  const corruptPath = receiptFiles.find(file => file.endsWith(`${second.receiptHash}.json`));
  const corruptBytes = Buffer.from('{"interrupted":"receipt"}\n');
  await fs.writeFile(corruptPath, corruptBytes);
  const indexPath = await onlyJsonFile(path.join(rootPath, 'review-index'));
  await fs.unlink(indexPath);
  const interruptedLockPath = path.join(rootPath, '.extraction-write-lock');
  await fs.mkdir(interruptedLockPath, { mode: 0o700 });

  const reopened = new LocalSermonExtractionStore({ rootPath });
  assert.equal(
    await reopened.findReviewedSnapshot(reviewedLookup(snapshot, {
      projectId: 'service-other'
    })),
    null,
    'a lookup drift must not adopt another project review'
  );
  assert.deepEqual(await jsonFiles(path.join(rootPath, 'review-index')), []);

  const recovered = await reopened.findReviewedSnapshot(reviewedLookup(snapshot));
  assert.equal(recovered.snapshot.snapshotHash, snapshot.snapshotHash);
  assert.equal(recovered.receipt.receiptHash, first.receiptHash);
  assert.equal(recovered.reviewStatus.reviewed, true);
  assert.ok(recovered.reviewStatus.skippedCorruptReceipts >= 1);
  assert.deepEqual(
    await jsonFiles(path.join(rootPath, 'review-index')),
    [],
    'a fresh interrupted-process lock permits validated discovery without unsafe mutation'
  );
  assert.deepEqual(await fs.readFile(corruptPath), corruptBytes);

  await fs.rename(interruptedLockPath, `${interruptedLockPath}.simulated-crash`);
  const restartedAgain = new LocalSermonExtractionStore({ rootPath });
  assert.equal(
    (await restartedAgain.findReviewedSnapshot(reviewedLookup(snapshot)))
      .receipt.receiptHash,
    first.receiptHash
  );
  assert.equal((await jsonFiles(path.join(rootPath, 'review-index'))).length, 1);
});

test('restart reconciles a newer durable receipt into an existing exact review index', async t => {
  const rootPath = await tempDirectory(t);
  const store = new LocalSermonExtractionStore({ rootPath });
  const firstSnapshot = await savedSnapshot(store);
  const first = await store.saveReviewReceipt(receiptFor(firstSnapshot.snapshotHash));
  const indexPath = await onlyJsonFile(path.join(rootPath, 'review-index'));
  const olderIndexBytes = await fs.readFile(indexPath);

  // A newer extractor can produce a different private snapshot for the same
  // exact sermon/source/result lookup. Simulate interruption after its
  // immutable receipt is durable but before the existing index is replaced.
  const secondSnapshot = await savedSnapshot(store, {
    extraction: extraction({ extractorVersion: 2 })
  });
  const second = await store.saveReviewReceipt(receiptFor(secondSnapshot.snapshotHash, {
    resultingProjectRevisionId: 'e'.repeat(64),
    reviewedAt: '2026-07-28T13:00:00.000Z'
  }));
  await fs.writeFile(indexPath, olderIndexBytes, { mode: 0o600 });

  const reopened = new LocalSermonExtractionStore({ rootPath });
  const found = await reopened.findReviewedSnapshot(reviewedLookup(firstSnapshot));
  assert.equal(found.snapshot.snapshotHash, secondSnapshot.snapshotHash);
  assert.equal(found.receipt.receiptHash, second.receiptHash);
  assert.equal(found.receipt.reviewedAt, '2026-07-28T13:00:00.000Z');

  const reconciled = JSON.parse(await fs.readFile(indexPath, 'utf8'));
  assert.deepEqual(
    reconciled.receipts.map(reference => reference.receiptHash).sort(),
    [first.receiptHash, second.receiptHash].sort()
  );
  assert.equal(
    await reopened.findReviewedSnapshot(reviewedLookup(firstSnapshot, {
      projectId: 'service-other'
    })),
    null,
    'reconciliation must not adopt a receipt from another exact lookup'
  );
  assert.equal((await jsonFiles(path.join(rootPath, 'review-index'))).length, 1);
});

test('review recovery scan does not retain a store-wide parsed snapshot cache', () => {
  const scanSource = LocalSermonExtractionStore.prototype._scanReviewReferences.toString();
  assert.doesNotMatch(scanSource, /snapshotCache|new Map\s*\(/);
  assert.match(scanSource, /let snapshot = null;\s+let snapshotRead = false;/);
});

test('review status skips corrupt receipts but preserves them, while exact review-index corruption fails', async t => {
  const rootPath = await tempDirectory(t);
  const store = new LocalSermonExtractionStore({ rootPath });
  const snapshot = await savedSnapshot(store);
  const first = await store.saveReviewReceipt(receiptFor(snapshot.snapshotHash));
  const second = await store.saveReviewReceipt(receiptFor(snapshot.snapshotHash, {
    resultingProjectRevisionId: 'e'.repeat(64),
    reviewedAt: '2026-07-28T13:00:00.000Z'
  }));
  const receiptFiles = await jsonFiles(path.join(rootPath, 'receipts'));
  const corruptPath = receiptFiles.find(file => file.endsWith(`${second.receiptHash}.json`));
  const corruptBytes = Buffer.from('{"corrupt":"receipt"}\n');
  await fs.writeFile(corruptPath, corruptBytes);

  const status = await store.readReviewStatus({ snapshotHash: snapshot.snapshotHash });
  assert.equal(status.reviewed, true);
  assert.equal(status.skippedCorruptReceipts, 1);
  assert.deepEqual(status.receipts.map(item => item.receiptHash), [first.receiptHash]);
  assert.deepEqual(await fs.readFile(corruptPath), corruptBytes);

  const found = await store.findReviewedSnapshot(reviewedLookup(snapshot));
  assert.equal(found.receipt.receiptHash, first.receiptHash);
  assert.ok(found.reviewStatus.skippedCorruptReceipts >= 1);
  assert.deepEqual(await fs.readFile(corruptPath), corruptBytes);

  const indexPath = await onlyJsonFile(path.join(rootPath, 'review-index'));
  const corruptIndex = Buffer.from('not json\n');
  await fs.writeFile(indexPath, corruptIndex);
  await assert.rejects(
    store.findReviewedSnapshot(reviewedLookup(snapshot)),
    expectStoreCode('REVIEW_INDEX_CORRUPT', [rootPath])
  );
  await assert.rejects(
    store.saveReviewReceipt(receiptFor(snapshot.snapshotHash, {
      reviewedAt: '2026-07-28T14:00:00.000Z'
    })),
    expectStoreCode('REVIEW_INDEX_CORRUPT', [rootPath])
  );
  assert.deepEqual(await fs.readFile(indexPath), corruptIndex);
});

test('review receipt capacity is bounded while exact retry remains available', async t => {
  const rootPath = await tempDirectory(t);
  const store = new LocalSermonExtractionStore({
    rootPath,
    maximumReviewReceipts: 1
  });
  const snapshot = await savedSnapshot(store);
  const first = await store.saveReviewReceipt(receiptFor(snapshot.snapshotHash));
  assert.equal((await store.saveReviewReceipt(receiptFor(snapshot.snapshotHash))).unchanged, true);
  await assert.rejects(
    store.saveReviewReceipt(receiptFor(snapshot.snapshotHash, {
      reviewedAt: '2026-07-28T15:00:00.000Z'
    })),
    expectStoreCode('REVIEW_RECEIPT_CAPACITY_REACHED')
  );
  assert.deepEqual(
    (await store.readReviewStatus({ snapshotHash: snapshot.snapshotHash }))
      .receipts.map(item => item.receiptHash),
    [first.receiptHash]
  );
});

test('per-snapshot receipt capacity rejects the boundary write before publication', async t => {
  const rootPath = await tempDirectory(t);
  const store = new LocalSermonExtractionStore({
    rootPath,
    maximumReviewReceipts: 10,
    maximumReviewReceiptsPerSnapshot: 2
  });
  const snapshot = await savedSnapshot(store);
  const firstRequest = receiptFor(snapshot.snapshotHash);
  const first = await store.saveReviewReceipt(firstRequest);
  const second = await store.saveReviewReceipt(receiptFor(snapshot.snapshotHash, {
    resultingProjectRevisionId: 'e'.repeat(64),
    reviewedAt: '2026-07-28T13:00:00.000Z'
  }));

  await assert.rejects(
    store.saveReviewReceipt(receiptFor(snapshot.snapshotHash, {
      projectId: 'service-other',
      resultingProjectRevisionId: 'f'.repeat(64),
      reviewedAt: '2026-07-28T14:00:00.000Z'
    })),
    expectStoreCode('REVIEW_RECEIPT_SNAPSHOT_CAPACITY_REACHED')
  );
  assert.equal((await jsonFiles(path.join(rootPath, 'receipts'))).length, 2);
  assert.equal((await store.saveReviewReceipt(firstRequest)).unchanged, true);
  assert.deepEqual(
    (await store.readReviewStatus({ snapshotHash: snapshot.snapshotHash }))
      .receipts.map(receipt => receipt.receiptHash),
    [second.receiptHash, first.receiptHash]
  );
  assert.equal(
    (await new LocalSermonExtractionStore({
      rootPath,
      maximumReviewReceiptsPerSnapshot: 2
    }).findReviewedSnapshot(reviewedLookup(snapshot))).receipt.receiptHash,
    second.receiptHash
  );
});
