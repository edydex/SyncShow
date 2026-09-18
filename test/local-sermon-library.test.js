'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const {
  LocalSermonLibrary,
  MAX_PAGE_SIZE,
  SermonLibraryError,
  sermonIdStorageKey
} = require('../src/services/sermon/LocalSermonLibrary');
const {
  SermonDocumentError,
  serializeSermonDocument
} = require('../src/services/sermon/SermonDocument');

async function tempDirectory(t, prefix = 'syncshow-sermon-library-') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return fs.realpath(directory);
}

function bibleRange(bookId = 'Eph', chapter = 3, verseStart = 14, verseEnd = 21) {
  return {
    schemaVersion: 1,
    bookId,
    start: { chapter, verse: verseStart },
    end: { chapter, verse: verseEnd }
  };
}

function sermonDocument(overrides = {}) {
  const base = {
    schemaVersion: 1,
    kind: 'syncshow-sermon',
    id: 'sermon-2026-07-26-prayer',
    titles: {
      en: 'The Prayer That Transforms the Church',
      ru: 'Молитва, преображающая Церковь'
    },
    defaultLanguage: 'en',
    speaker: {
      id: 'paul-lvutin',
      name: 'Paul Lvutin'
    },
    serviceDate: '2026-07-26',
    series: {
      id: 'from-pain-to-unity',
      titles: {
        en: 'From Pain to Unity',
        ru: 'От боли к единству'
      }
    },
    outline: [{
      id: 'foundation',
      parentId: null,
      kind: 'section',
      titles: {
        en: 'The Foundation of the Prayer',
        ru: 'Основание молитвы'
      }
    }],
    sources: [{
      id: 'pastor-manuscript',
      kind: 'manuscript',
      fileName: '07-26-26-sermon.pdf',
      mediaType: 'application/pdf',
      language: 'ru',
      sha256: 'a'.repeat(64),
      sizeBytes: 184320,
      provenance: {
        providedBy: 'Paul Lvutin',
        receivedAt: '2026-07-24T18:30:00Z',
        sourceSystem: 'pastor-email',
        externalId: 'message-2026-07-24'
      }
    }],
    references: [{
      id: 'primary-eph-3-14-21',
      range: bibleRange(),
      role: 'primary',
      source: 'pastor',
      reviewStatus: 'confirmed',
      enteredText: 'Ephesians 3:14-21',
      sourceId: 'pastor-manuscript',
      sectionId: 'foundation',
      startOffset: null,
      endOffset: null
    }],
    media: [],
    publication: {
      status: 'draft',
      visibility: 'private',
      publishedAt: null,
      canonicalUrl: null
    }
  };
  return {
    ...base,
    ...overrides
  };
}

function v3SermonDocument(body = null) {
  const legacy = sermonDocument();
  return {
    ...legacy,
    schemaVersion: 3,
    sources: legacy.sources.map(source => {
      const { language, ...rest } = source;
      return {
        ...rest,
        languages: [language, 'en']
      };
    }),
    body: body || [{
      id: 'manuscript-foundation-ru',
      kind: 'manuscript',
      language: 'ru',
      sourceId: 'pastor-manuscript',
      sectionId: 'foundation',
      text: 'Для сего преклоняю колени мои пред Отцом.'
    }, {
      id: 'manuscript-foundation-en',
      kind: 'manuscript',
      language: 'en',
      sourceId: 'pastor-manuscript',
      sectionId: 'foundation',
      text: 'For this reason I bow my knees before the Father.'
    }]
  };
}

function editableCopy(document) {
  return JSON.parse(JSON.stringify(document));
}

function expectLibraryCode(code) {
  return error => {
    assert.ok(
      error instanceof SermonLibraryError,
      `expected SermonLibraryError, got ${error?.constructor?.name}`
    );
    assert.equal(error.code, code);
    return true;
  };
}

test('constructor requires an absolute root and sermon identities cannot become storage paths', () => {
  assert.throws(
    () => new LocalSermonLibrary({ rootPath: 'relative/sermons' }),
    TypeError
  );
  const key = sermonIdStorageKey('../../outside/sermon');
  assert.match(key, /^sermon-[a-f0-9]{64}$/);
  assert.equal(key.includes('..'), false);
  assert.equal(key.includes('/'), false);
  assert.notEqual(sermonIdStorageKey('sermon-a'), sermonIdStorageKey('sermon-b'));
});

test('validation is read-only, canonical, and refuses workstation source paths', async t => {
  const parentPath = await tempDirectory(t, 'syncshow-sermon-validation-');
  const rootPath = path.join(parentPath, 'not-created');
  const library = new LocalSermonLibrary({ rootPath });
  const validated = await library.validateDocument(sermonDocument(), {
    expectedSermonId: 'sermon-2026-07-26-prayer'
  });

  assert.equal(validated.sermon.id, 'sermon-2026-07-26-prayer');
  assert.equal(validated.source, serializeSermonDocument(sermonDocument()));
  assert.equal(
    crypto.createHash('sha256').update(validated.source).digest('hex'),
    validated.revision
  );
  await assert.rejects(fs.stat(rootPath), error => error.code === 'ENOENT');

  const unsafe = sermonDocument();
  unsafe.sources[0].localPath = '/Users/pastor/Downloads/sermon.pdf';
  await assert.rejects(
    library.validateDocument(unsafe),
    error => error instanceof SermonDocumentError
      && error.code === 'LOCAL_PATH_NOT_ALLOWED'
  );
});

test('create, read, list, and restart preserve canonical immutable sermon JSON', async t => {
  const rootPath = await tempDirectory(t);
  const now = new Date('2026-07-27T20:00:00.000Z');
  const library = new LocalSermonLibrary({ rootPath, clock: () => now });
  const saved = await library.saveDocument(sermonDocument(), {
    expectedRevision: null
  });

  assert.equal(saved.unchanged, false);
  assert.equal(saved.sermon.id, 'sermon-2026-07-26-prayer');
  assert.equal(saved.document, saved.sermon);
  assert.equal(saved.updatedAt, now.toISOString());
  assert.equal(saved.summary.revision, saved.revision);
  assert.match(saved.revision, /^[a-f0-9]{64}$/);
  assert.equal(
    crypto.createHash('sha256').update(saved.source).digest('hex'),
    saved.revision
  );
  assert.equal(saved.source.includes(rootPath), false);
  assert.equal(saved.source.includes('/Users/'), false);

  const restarted = new LocalSermonLibrary({ rootPath });
  const reopened = await restarted.readCurrent(saved.sermon.id);
  assert.deepEqual(reopened.sermon, saved.sermon);
  assert.equal(reopened.source, saved.source);
  assert.equal(reopened.revision, saved.revision);
  assert.equal(reopened.updatedAt, saved.updatedAt);

  const listed = await restarted.list();
  assert.equal(listed.total, 1);
  assert.deepEqual(listed.items[0], saved.summary);

  const versionsPath = path.join(
    rootPath,
    sermonIdStorageKey(saved.sermon.id),
    'versions'
  );
  assert.deepEqual(await fs.readdir(versionsPath), [`${saved.revision}.json`]);
});

test('restart preserves exact ordered v3 sermon bodies and their immutable prior revision', async t => {
  const rootPath = await tempDirectory(t, 'syncshow-v3-sermon-library-');
  const library = new LocalSermonLibrary({ rootPath });
  const originalDocument = v3SermonDocument();
  const original = await library.saveDocument(originalDocument, {
    expectedRevision: null
  });
  const revisedDocument = editableCopy(original.sermon);
  revisedDocument.body[0].text =
    'Для сего преклоняю колени мои пред Отцом Господа нашего Иисуса Христа.';
  revisedDocument.body.push({
    id: 'manuscript-application-en',
    kind: 'manuscript',
    language: 'en',
    sourceId: 'pastor-manuscript',
    sectionId: 'foundation',
    text: 'The reviewed application remains the final ordered body entry.'
  });
  const revised = await library.saveDocument(revisedDocument, {
    expectedSermonId: original.sermon.id,
    expectedRevision: original.revision
  });

  const restarted = new LocalSermonLibrary({ rootPath });
  const current = await restarted.readCurrent(original.sermon.id);
  assert.equal(current.revision, revised.revision);
  assert.equal(current.source, serializeSermonDocument(revisedDocument));
  assert.deepEqual(
    current.sermon.body.map(entry => entry.id),
    [
      'manuscript-foundation-ru',
      'manuscript-foundation-en',
      'manuscript-application-en'
    ]
  );
  assert.deepEqual(current.sermon.body, revisedDocument.body);

  const historical = await restarted.readRevision(
    original.sermon.id,
    original.revision
  );
  assert.equal(historical.source, original.source);
  assert.deepEqual(historical.sermon.body, originalDocument.body);
});

test('exact revisions remain readable after the current sermon advances', async t => {
  const rootPath = await tempDirectory(t);
  const library = new LocalSermonLibrary({ rootPath });
  const first = await library.saveDocument(sermonDocument());
  const changedDocument = editableCopy(first.sermon);
  changedDocument.titles.en = 'A Revised Sermon Title';
  const changed = await library.saveDocument(changedDocument, {
    expectedSermonId: first.sermon.id,
    expectedRevision: first.revision
  });

  assert.notEqual(changed.revision, first.revision);
  assert.equal((await library.readCurrent(first.sermon.id)).revision, changed.revision);

  const pinned = await library.readRevision(first.sermon.id, first.revision);
  assert.equal(pinned.revision, first.revision);
  assert.equal(pinned.sermon.titles.en, 'The Prayer That Transforms the Church');
  assert.equal(pinned.updatedAt, null);

  const versions = await fs.readdir(path.join(
    rootPath,
    sermonIdStorageKey(first.sermon.id),
    'versions'
  ));
  assert.deepEqual(
    versions.sort(),
    [`${first.revision}.json`, `${changed.revision}.json`].sort()
  );
});

test('staging preserves the current pointer until an exact CAS promotion', async t => {
  const rootPath = await tempDirectory(t);
  const library = new LocalSermonLibrary({ rootPath });
  const original = await library.saveDocument(sermonDocument());
  const reviewedDocument = editableCopy(original.sermon);
  reviewedDocument.titles.en = 'A Staged Reviewed Sermon';

  const staged = await library.stageDocument(reviewedDocument, {
    expectedSermonId: original.sermon.id,
    expectedRevision: original.revision
  });
  assert.equal(staged.staged, true);
  assert.notEqual(staged.revision, original.revision);
  assert.equal(
    (await library.readCurrent(original.sermon.id)).revision,
    original.revision,
    'staging must not advance the canonical current pointer'
  );
  assert.equal(
    (await library.readRevision(original.sermon.id, staged.revision)).sermon.titles.en,
    'A Staged Reviewed Sermon'
  );

  const promoted = await library.promoteRevision(
    original.sermon.id,
    staged.revision,
    { expectedRevision: original.revision }
  );
  assert.equal(promoted.unchanged, false);
  assert.equal((await library.readCurrent(original.sermon.id)).revision, staged.revision);

  await assert.rejects(
    library.promoteRevision(
      original.sermon.id,
      original.revision,
      { expectedRevision: original.revision }
    ),
    expectLibraryCode('SERMON_CONFLICT')
  );
});

test('canonical no-op saves deduplicate revisions and retain the first update time', async t => {
  const rootPath = await tempDirectory(t);
  let now = new Date('2026-07-27T20:00:00.000Z');
  const library = new LocalSermonLibrary({ rootPath, clock: () => now });
  const first = await library.saveDocument(sermonDocument());
  now = new Date('2026-07-27T21:00:00.000Z');

  const reordered = Object.fromEntries(
    Object.entries(JSON.parse(first.source)).reverse()
  );
  const second = await library.saveSource(JSON.stringify(reordered, null, 4), {
    expectedRevision: first.revision
  });

  assert.equal(second.unchanged, true);
  assert.equal(second.revision, first.revision);
  assert.equal(second.updatedAt, first.updatedAt);
  const versions = await fs.readdir(path.join(
    rootPath,
    sermonIdStorageKey(first.sermon.id),
    'versions'
  ));
  assert.deepEqual(versions, [`${first.revision}.json`]);
});

test('compare-and-swap blocks blind replacement, stale editors, and identity changes', async t => {
  const rootPath = await tempDirectory(t);
  const library = new LocalSermonLibrary({ rootPath });
  const original = await library.saveDocument(sermonDocument());
  const editorOneDocument = editableCopy(original.sermon);
  editorOneDocument.titles.en = 'Editor One Title';

  await assert.rejects(
    library.saveDocument(editorOneDocument),
    expectLibraryCode('SERMON_CONFLICT')
  );

  const changed = await library.saveDocument(editorOneDocument, {
    expectedSermonId: original.sermon.id,
    expectedRevision: original.revision
  });
  const staleDocument = editableCopy(original.sermon);
  staleDocument.titles.en = 'Stale Editor Title';
  await assert.rejects(
    library.saveDocument(staleDocument, {
      expectedSermonId: original.sermon.id,
      expectedRevision: original.revision
    }),
    error => {
      expectLibraryCode('SERMON_CONFLICT')(error);
      assert.equal(error.details.expectedRevision, original.revision);
      assert.equal(error.details.currentRevision, changed.revision);
      return true;
    }
  );

  const renamed = editableCopy(changed.sermon);
  renamed.id = 'renamed-sermon';
  await assert.rejects(
    library.saveDocument(renamed, {
      expectedSermonId: original.sermon.id,
      expectedRevision: changed.revision
    }),
    expectLibraryCode('SERMON_ID_CHANGED')
  );
  assert.equal((await library.readCurrent(original.sermon.id)).revision, changed.revision);
});

test('checksum and pointer corruption remain visible without poisoning library browsing', async t => {
  const rootPath = await tempDirectory(t);
  const library = new LocalSermonLibrary({ rootPath });
  const saved = await library.saveDocument(sermonDocument());
  const sermonDirectory = path.join(rootPath, sermonIdStorageKey(saved.sermon.id));
  const revisionPath = path.join(
    sermonDirectory,
    'versions',
    `${saved.revision}.json`
  );
  await fs.writeFile(
    revisionPath,
    saved.source.replace('The Prayer That Transforms the Church', 'Tampered sermon')
  );

  await assert.rejects(
    library.readCurrent(saved.sermon.id),
    expectLibraryCode('LIBRARY_REVISION_CORRUPT')
  );
  assert.deepEqual(
    await library.list(),
    { items: [], total: 0, offset: 0, nextOffset: null }
  );
  assert.match(await fs.readFile(revisionPath, 'utf8'), /Tampered sermon/);

  const second = await library.saveDocument(sermonDocument({
    id: 'sermon-valid-pointer-test',
    titles: { en: 'Pointer Test' },
    defaultLanguage: 'en'
  }));
  const pointerPath = path.join(
    rootPath,
    sermonIdStorageKey(second.sermon.id),
    'current.json'
  );
  await fs.writeFile(pointerPath, '{ definitely not json }\n');
  await assert.rejects(
    library.readCurrent(second.sermon.id),
    expectLibraryCode('LIBRARY_POINTER_INVALID')
  );
  assert.equal(await fs.readFile(pointerPath, 'utf8'), '{ definitely not json }\n');
});

test('symbolic storage roots, item directories, and revision files are never followed', async t => {
  if (process.platform === 'win32') {
    t.skip('Creating symlinks is not reliably permitted on Windows CI.');
    return;
  }
  const parentPath = await tempDirectory(t, 'syncshow-sermon-symlink-');
  const outsidePath = await tempDirectory(t, 'syncshow-sermon-outside-');
  const linkedRoot = path.join(parentPath, 'linked-root');
  await fs.symlink(outsidePath, linkedRoot);
  await assert.rejects(
    new LocalSermonLibrary({ rootPath: linkedRoot }).initialize(),
    /Unsafe storage directory/
  );

  const rootPath = path.join(parentPath, 'safe-root');
  const library = await new LocalSermonLibrary({ rootPath }).initialize();
  const escapedId = 'sermon-escaped-directory';
  const escapedDirectory = path.join(rootPath, sermonIdStorageKey(escapedId));
  await fs.symlink(outsidePath, escapedDirectory);
  await assert.rejects(
    library.readCurrent(escapedId),
    expectLibraryCode('LIBRARY_POINTER_INVALID')
  );
  await fs.unlink(escapedDirectory);

  const saved = await library.saveDocument(sermonDocument());
  const revisionPath = path.join(
    rootPath,
    sermonIdStorageKey(saved.sermon.id),
    'versions',
    `${saved.revision}.json`
  );
  const outsideFile = path.join(outsidePath, 'outside-sermon.json');
  await fs.writeFile(outsideFile, saved.source);
  await fs.unlink(revisionPath);
  await fs.symlink(outsideFile, revisionPath);
  await assert.rejects(
    library.readCurrent(saved.sermon.id),
    expectLibraryCode('LIBRARY_REVISION_MISSING')
  );
});

test('list search spans languages, speaker, series, passage, filters, and pagination', async t => {
  const rootPath = await tempDirectory(t);
  const library = new LocalSermonLibrary({ rootPath });
  await library.saveDocument(sermonDocument());
  await library.saveDocument(sermonDocument({
    id: 'sermon-2026-07-19-grace',
    titles: {
      en: 'Grace for the Weary'
    },
    defaultLanguage: 'en',
    speaker: {
      id: 'john-smith',
      name: 'John Smith'
    },
    serviceDate: '2026-07-19',
    series: null,
    sources: [],
    outline: [],
    references: [{
      id: 'primary-rom-8-1',
      range: bibleRange('Rom', 8, 1, 1),
      role: 'primary',
      source: 'operator',
      reviewStatus: 'confirmed',
      enteredText: 'Romans 8:1'
    }],
    publication: {
      status: 'ready',
      visibility: 'members'
    }
  }));
  await library.saveDocument(sermonDocument({
    id: 'sermon-2026-07-12-unity',
    titles: {
      ru: 'Единство церкви'
    },
    defaultLanguage: 'ru',
    speaker: {
      id: 'pavel-ivanov',
      name: 'Павел Иванов'
    },
    serviceDate: '2026-07-12',
    series: {
      id: 'church-life',
      titles: {
        ru: 'Жизнь церкви'
      }
    },
    sources: [],
    outline: [],
    references: [{
      id: 'primary-eph-4-3',
      range: bibleRange('Eph', 4, 3, 3),
      role: 'primary',
      source: 'operator',
      reviewStatus: 'confirmed',
      enteredText: 'К Ефесянам 4:3'
    }]
  }));

  assert.deepEqual(
    (await library.list({ query: 'ПАВЕЛ жизнь' })).items.map(item => item.id),
    ['sermon-2026-07-12-unity']
  );
  assert.deepEqual(
    (await library.list({ query: 'Eph foundation' })).items.map(item => item.id),
    ['sermon-2026-07-26-prayer']
  );
  assert.deepEqual(
    (await library.list({ language: 'ru' })).items.map(item => item.id),
    ['sermon-2026-07-26-prayer', 'sermon-2026-07-12-unity']
  );
  assert.deepEqual(
    (await library.list({
      publicationStatus: 'ready',
      visibility: 'members',
      speakerId: 'john-smith'
    })).items.map(item => item.id),
    ['sermon-2026-07-19-grace']
  );

  const firstPage = await library.list({ pageSize: 2 });
  assert.deepEqual(firstPage.items.map(item => item.serviceDate), [
    '2026-07-26',
    '2026-07-19'
  ]);
  assert.equal(firstPage.total, 3);
  assert.equal(firstPage.nextOffset, 2);
  const secondPage = await library.list({
    pageSize: 2,
    offset: firstPage.nextOffset
  });
  assert.deepEqual(secondPage.items.map(item => item.serviceDate), ['2026-07-12']);
  assert.equal(secondPage.nextOffset, null);
  assert.equal((await library.list({ pageSize: MAX_PAGE_SIZE + 500 })).items.length, 3);

  await assert.rejects(
    library.list({ query: 'x'.repeat(121) }),
    expectLibraryCode('QUERY_TOO_LONG')
  );
});
