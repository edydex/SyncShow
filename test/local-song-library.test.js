'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const {
  LocalSongLibrary,
  MAX_PAGE_SIZE,
  SongLibraryError,
  idStorageKey
} = require('../src/services/project/LocalSongLibrary');

async function tempDirectory(t, prefix = 'syncshow-song-library-') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return fs.realpath(directory);
}

function songSource(options = {}) {
  const id = options.id || 'amazing-grace';
  const title = options.title || 'Amazing Grace';
  const language = options.language || 'en';
  const lines = options.lines || ['Amazing grace', 'How sweet the sound'];
  const metadata = [
    '---',
    `id: ${id}`,
    `title: ${JSON.stringify(title)}`,
    `language: ${language}`
  ];
  if (options.translationOf) metadata.push(`translationOf: ${options.translationOf}`);
  if (options.tags) metadata.push(`tags: ${JSON.stringify(options.tags)}`);
  if (options.authors) metadata.push(`authors: ${JSON.stringify(options.authors)}`);
  if (options.translators) metadata.push(`translators: ${JSON.stringify(options.translators)}`);
  if (options.composers) metadata.push(`composers: ${JSON.stringify(options.composers)}`);
  if (options.license) metadata.push(`license: ${JSON.stringify(options.license)}`);
  if (options.source) metadata.push(`source: ${JSON.stringify(options.source)}`);
  if (options.attribution) metadata.push(`attribution: ${JSON.stringify(options.attribution)}`);
  const body = options.body || `^1\n${lines.join('\n')}`;
  return `${metadata.join('\n')}\n---\n\n${body}\n`;
}

function expectLibraryCode(code) {
  return error => {
    assert.ok(error instanceof SongLibraryError, `expected SongLibraryError, got ${error?.constructor?.name}`);
    assert.equal(error.code, code);
    return true;
  };
}

test('constructor requires an absolute root and storage keys never contain user-controlled paths', () => {
  assert.throws(() => new LocalSongLibrary({ rootPath: 'relative/library' }), TypeError);
  const key = idStorageKey('../../outside/song');
  assert.match(key, /^song-[a-f0-9]{64}$/);
  assert.equal(key.includes('..'), false);
  assert.notEqual(idStorageKey('song-a'), idStorageKey('song-b'));
});

test('save, read, list, and restart preserve a canonical immutable song revision', async t => {
  const rootPath = await tempDirectory(t);
  const now = new Date('2026-07-22T12:00:00.000Z');
  const library = new LocalSongLibrary({ rootPath, clock: () => now });
  const saved = await library.saveSource(songSource({
    tags: ['hymn', 'grace'],
    authors: ['John Newton'],
    license: 'Public domain'
  }), { fileName: 'Amazing Grace.md' });

  assert.equal(saved.unchanged, false);
  assert.equal(saved.song.id, 'amazing-grace');
  assert.equal(saved.summary.revision, saved.revision);
  assert.equal(saved.summary.updatedAt, now.toISOString());
  assert.match(saved.revision, /^[a-f0-9]{64}$/);
  assert.equal(crypto.createHash('sha256').update(saved.source).digest('hex'), saved.revision);

  const restarted = new LocalSongLibrary({ rootPath });
  const reopened = await restarted.read('amazing-grace');
  assert.deepEqual(reopened.song, saved.song);
  assert.equal(reopened.source, saved.source);
  assert.equal(reopened.revision, saved.revision);

  const listed = await restarted.list();
  assert.equal(listed.total, 1);
  assert.deepEqual(listed.items[0], saved.summary);

  const versionsPath = path.join(rootPath, idStorageKey('amazing-grace'), 'versions');
  assert.deepEqual(await fs.readdir(versionsPath), [`${saved.revision}.md`]);
});

test('canonical no-op saves deduplicate revisions and retain the original update timestamp', async t => {
  const rootPath = await tempDirectory(t);
  let now = new Date('2026-07-22T12:00:00.000Z');
  const library = new LocalSongLibrary({ rootPath, clock: () => now });
  const first = await library.saveSource(songSource());
  now = new Date('2026-07-22T13:00:00.000Z');

  const equivalentWithCrLf = songSource().replace(/\n/g, '\r\n');
  const second = await library.saveSource(equivalentWithCrLf, {
    expectedRevision: first.revision
  });

  assert.equal(second.unchanged, true);
  assert.equal(second.revision, first.revision);
  assert.equal(second.updatedAt, first.updatedAt);
  const versions = await fs.readdir(path.join(rootPath, idStorageKey(first.song.id), 'versions'));
  assert.deepEqual(versions, [`${first.revision}.md`]);
});

test('compare-and-swap prevents blind replacement and stale editors from losing changes', async t => {
  const rootPath = await tempDirectory(t);
  const library = new LocalSongLibrary({ rootPath });
  const original = await library.saveSource(songSource());
  const changedSource = songSource({ lines: ['Changed by editor one'] });

  await assert.rejects(
    library.saveSource(changedSource),
    expectLibraryCode('SONG_CONFLICT')
  );

  const changed = await library.saveSource(changedSource, {
    expectedRevision: original.revision
  });
  assert.notEqual(changed.revision, original.revision);

  await assert.rejects(
    library.saveSource(songSource({ lines: ['Stale editor change'] }), {
      expectedRevision: original.revision
    }),
    error => {
      expectLibraryCode('SONG_CONFLICT')(error);
      assert.equal(error.details.expectedRevision, original.revision);
      assert.equal(error.details.currentRevision, changed.revision);
      return true;
    }
  );
  assert.equal((await library.read('amazing-grace')).revision, changed.revision);
  const pinnedOriginal = await library.read('amazing-grace', { revision: original.revision });
  assert.equal(pinnedOriginal.revision, original.revision);
  assert.match(pinnedOriginal.source, /Amazing grace/);
  assert.doesNotMatch(pinnedOriginal.source, /Changed by editor one/);
});

test('identity-safe editor saves reject renamed songs before touching another storage identity', async t => {
  const rootPath = await tempDirectory(t);
  const library = new LocalSongLibrary({ rootPath });
  const original = await library.saveSource(songSource());

  await assert.rejects(
    library.saveSource(songSource({
      id: 'renamed-behind-the-editors-back',
      title: 'Renamed',
      lines: ['Changed lyrics']
    }), {
      expectedSongId: original.song.id,
      expectedRevision: original.revision
    }),
    error => {
      expectLibraryCode('SONG_ID_CHANGED')(error);
      assert.equal(error.details.expectedSongId, 'amazing-grace');
      assert.equal(error.details.actualSongId, 'renamed-behind-the-editors-back');
      return true;
    }
  );
  await assert.rejects(
    library.saveSource(songSource({ lines: ['Do not silently fork this edit'] }), {
      expectedSongId: original.song.id,
      expectedRevision: original.revision,
      onConflict: 'fork'
    }),
    expectLibraryCode('INVALID_SAVE_MODE')
  );

  assert.equal((await library.read('amazing-grace')).revision, original.revision);
  await assert.rejects(
    library.read('renamed-behind-the-editors-back'),
    expectLibraryCode('SONG_NOT_FOUND')
  );
  assert.equal(
    await fs.stat(path.join(rootPath, idStorageKey('renamed-behind-the-editors-back')))
      .then(() => true, error => error.code === 'ENOENT' ? false : Promise.reject(error)),
    false
  );
});

test('source validation is read-only when the library directory does not exist yet', async t => {
  const parentPath = await tempDirectory(t, 'syncshow-song-validation-');
  const rootPath = path.join(parentPath, 'not-created');
  const library = new LocalSongLibrary({ rootPath });

  const validated = await library.validateSource(songSource({
    id: 'read-only-draft',
    title: 'Read-only Draft'
  }), {
    expectedSongId: 'read-only-draft'
  });

  assert.equal(validated.song.id, 'read-only-draft');
  assert.equal(validated.relationship.kind, 'original');
  await assert.rejects(fs.stat(rootPath), error => error.code === 'ENOENT');
});

test('new attribution is bounded while an unchanged long schema-v1 credit remains editable', async t => {
  const rootPath = await tempDirectory(t);
  const library = new LocalSongLibrary({ rootPath });
  const longCredit = 'x'.repeat(501);
  const longSource = songSource({
    id: 'legacy-long-credit',
    title: 'Legacy Long Credit',
    attribution: longCredit
  });

  await assert.rejects(
    library.validateSource(longSource),
    expectLibraryCode('ATTRIBUTION_TOO_LONG')
  );

  const revision = crypto.createHash('sha256').update(longSource).digest('hex');
  const songDirectory = path.join(rootPath, idStorageKey('legacy-long-credit'));
  await fs.mkdir(path.join(songDirectory, 'versions'), { recursive: true });
  await fs.writeFile(path.join(songDirectory, 'versions', `${revision}.md`), longSource);
  await fs.writeFile(path.join(songDirectory, 'current.json'), `${JSON.stringify({
    schemaVersion: 1,
    songId: 'legacy-long-credit',
    revision,
    updatedAt: '2026-07-22T12:00:00.000Z'
  })}\n`);

  assert.equal((await library.read('legacy-long-credit')).song.attribution, longCredit);
  const preserved = await library.validateSource(longSource, {
    expectedSongId: 'legacy-long-credit'
  });
  assert.equal(preserved.song.attribution, longCredit);

  await assert.rejects(
    library.validateSource(songSource({
      id: 'legacy-long-credit',
      title: 'Legacy Long Credit',
      attribution: 'y'.repeat(501)
    }), {
      expectedSongId: 'legacy-long-credit'
    }),
    expectLibraryCode('ATTRIBUTION_TOO_LONG')
  );
});

test('translation relationships resolve to a root while incomplete structures remain saveable drafts', async t => {
  const rootPath = await tempDirectory(t);
  const library = new LocalSongLibrary({ rootPath });
  const original = await library.saveSource(songSource({
    id: 'root-song',
    title: 'Root Song',
    body: '^1\nRoot verse\n\n^chorus\nRoot chorus'
  }));
  const spanish = await library.saveSource(songSource({
    id: 'root-song-es',
    title: 'Canción raíz',
    language: 'es',
    translationOf: original.song.id,
    body: '^1\nVerso\n\n^chorus\nCoro'
  }), { expectedRevision: null });
  assert.equal(spanish.relationship.compatible, true);

  const ukrainian = await library.saveSource(songSource({
    id: 'root-song-uk',
    title: 'Коренева пісня',
    language: 'uk',
    translationOf: spanish.song.id,
    body: '^1\nЛише куплет'
  }), { expectedRevision: null });

  assert.equal(ukrainian.song.translationOf, original.song.id);
  assert.equal(ukrainian.relationship.familyId, original.song.id);
  assert.equal(ukrainian.relationship.normalizedFrom, spanish.song.id);
  assert.equal(ukrainian.relationship.compatible, false);
  assert.deepEqual(
    ukrainian.relationship.warnings.map(warning => warning.code),
    ['TRANSLATION_STRUCTURE_MISMATCH']
  );
  assert.match(ukrainian.source, /translationOf: root-song\n/);
  assert.equal((await library.read(ukrainian.song.id)).revision, ukrainian.revision);

  const validated = await library.validateSource(ukrainian.source, {
    expectedSongId: ukrainian.song.id
  });
  assert.equal(validated.documentSource, ukrainian.source);
  assert.equal(validated.relationship.compatible, false);
});

test('editing an original reports newly unaligned current translations without rewriting them', async t => {
  const rootPath = await tempDirectory(t);
  const library = new LocalSongLibrary({ rootPath });
  const original = await library.saveSource(songSource({
    id: 'warning-root',
    title: 'Warning Root',
    body: '^1\nVerse\n\n^chorus\nChorus'
  }));
  const translation = await library.saveSource(songSource({
    id: 'warning-translation',
    title: 'Warning Translation',
    language: 'de',
    translationOf: original.song.id,
    body: '^1\nStrophe\n\n^chorus\nRefrain'
  }), { expectedRevision: null });

  const changed = await library.saveSource(songSource({
    id: original.song.id,
    title: original.song.title,
    body: '^1\nChanged verse'
  }), {
    expectedSongId: original.song.id,
    expectedRevision: original.revision
  });

  assert.equal(changed.relationship.kind, 'original');
  assert.equal(changed.relationship.compatible, false);
  assert.equal(changed.relationship.translationCount, 1);
  assert.deepEqual(
    changed.relationship.warnings.map(warning => warning.code),
    ['TRANSLATIONS_MAY_NEED_ALIGNMENT']
  );
  assert.equal((await library.read(translation.song.id)).revision, translation.revision);
  assert.match((await library.read(translation.song.id)).source, /\n\^chorus\n/);
});

test('translation saves reject missing, self-referential, and root-with-children relationships', async t => {
  const rootPath = await tempDirectory(t);
  const library = new LocalSongLibrary({ rootPath });

  await assert.rejects(
    library.saveSource(songSource({
      id: 'missing-target-translation',
      translationOf: 'missing-root'
    }), { expectedRevision: null }),
    expectLibraryCode('TRANSLATION_TARGET_NOT_FOUND')
  );
  await assert.rejects(
    library.saveSource(songSource({
      id: 'self-translation',
      translationOf: 'self-translation'
    }), { expectedRevision: null }),
    expectLibraryCode('TRANSLATION_SELF_REFERENCE')
  );

  const root = await library.saveSource(songSource({
    id: 'family-root',
    title: 'Family Root'
  }));
  await library.saveSource(songSource({
    id: 'family-child',
    title: 'Family Child',
    language: 'ru',
    translationOf: root.song.id
  }), { expectedRevision: null });
  await library.saveSource(songSource({
    id: 'other-root',
    title: 'Other Root'
  }), { expectedRevision: null });

  await assert.rejects(
    library.saveSource(songSource({
      id: root.song.id,
      title: root.song.title,
      translationOf: 'other-root'
    }), {
      expectedSongId: root.song.id,
      expectedRevision: root.revision
    }),
    expectLibraryCode('TRANSLATION_ROOT_HAS_CHILDREN')
  );
  assert.equal((await library.read(root.song.id)).revision, root.revision);
});

test('forking creates independent versioned song identities without replacing the original', async t => {
  const rootPath = await tempDirectory(t);
  const library = new LocalSongLibrary({ rootPath });
  const original = await library.saveSource(songSource());
  const forkTwo = await library.saveSource(songSource({ lines: ['Local arrangement two'] }), {
    onConflict: 'fork'
  });
  const forkThree = await library.saveSource(songSource({ lines: ['Local arrangement three'] }), {
    onConflict: 'fork'
  });

  assert.equal(forkTwo.song.id, 'amazing-grace-local-2');
  assert.equal(forkThree.song.id, 'amazing-grace-local-3');
  assert.match(forkTwo.source, /\nid: amazing-grace-local-2\n/);
  assert.equal((await library.read('amazing-grace')).revision, original.revision);
  assert.equal((await library.read(forkTwo.song.id)).revision, forkTwo.revision);
  assert.equal((await library.list()).total, 3);
});

test('forking a maximum-length song id remains valid and preserves both immutable revisions', async t => {
  const rootPath = await tempDirectory(t);
  const library = new LocalSongLibrary({ rootPath });
  const maximumId = `a${'b'.repeat(127)}`;
  const original = await library.saveSource(songSource({
    id: maximumId,
    title: 'Maximum Identity'
  }));
  const forked = await library.saveSource(songSource({
    id: maximumId,
    title: 'Maximum Identity',
    lines: ['Forked local lyrics']
  }), {
    onConflict: 'fork'
  });

  assert.notEqual(forked.song.id, original.song.id);
  assert.ok(forked.song.id.length <= 128);
  assert.match(forked.song.id, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
  assert.equal((await library.read(original.song.id)).revision, original.revision);
  assert.equal((await library.read(forked.song.id)).revision, forked.revision);
});

test('the library mutation lock prevents concurrent relationship cycles and fork identity loss', async t => {
  const rootPath = await tempDirectory(t);
  const library = new LocalSongLibrary({ rootPath });
  const first = await library.saveSource(songSource({ id: 'cycle-a', title: 'Cycle A' }));
  const second = await library.saveSource(songSource({ id: 'cycle-b', title: 'Cycle B' }));

  const cycleAttempts = await Promise.allSettled([
    library.saveSource(songSource({
      id: first.song.id,
      title: first.song.title,
      translationOf: second.song.id
    }), {
      expectedSongId: first.song.id,
      expectedRevision: first.revision
    }),
    library.saveSource(songSource({
      id: second.song.id,
      title: second.song.title,
      translationOf: first.song.id
    }), {
      expectedSongId: second.song.id,
      expectedRevision: second.revision
    })
  ]);
  const cycleSuccesses = cycleAttempts.filter(result => result.status === 'fulfilled');
  assert.equal(cycleSuccesses.length, 1);
  const currentFirst = await library.read(first.song.id);
  const currentSecond = await library.read(second.song.id);
  assert.equal(
    currentFirst.song.translationOf === second.song.id
      && currentSecond.song.translationOf === first.song.id,
    false
  );

  const forkBase = await library.saveSource(songSource({
    id: 'concurrent-fork',
    title: 'Concurrent Fork'
  }));
  const forkAttempts = await Promise.allSettled([
    library.saveSource(songSource({
      id: forkBase.song.id,
      title: forkBase.song.title,
      lines: ['First concurrent import']
    }), { onConflict: 'fork' }),
    library.saveSource(songSource({
      id: forkBase.song.id,
      title: forkBase.song.title,
      lines: ['Second concurrent import']
    }), { onConflict: 'fork' })
  ]);
  const forkSuccesses = forkAttempts
    .filter(result => result.status === 'fulfilled')
    .map(result => result.value);
  assert.ok(forkSuccesses.length >= 1);
  assert.equal(new Set(forkSuccesses.map(result => result.song.id)).size, forkSuccesses.length);
  for (const result of forkSuccesses) {
    assert.equal((await library.read(result.song.id)).revision, result.revision);
  }
});

test('file import pins content so source deletion does not affect restart, and symlinks are refused', async t => {
  const rootPath = await tempDirectory(t);
  const importsPath = await tempDirectory(t, 'syncshow-song-import-');
  const sourcePath = path.join(importsPath, 'grace.md');
  await fs.writeFile(sourcePath, songSource());
  const library = new LocalSongLibrary({ rootPath });
  const imported = await library.importFile(sourcePath);
  await fs.unlink(sourcePath);

  assert.equal((await new LocalSongLibrary({ rootPath }).read(imported.song.id)).revision, imported.revision);

  if (process.platform !== 'win32') {
    const outsidePath = path.join(importsPath, 'outside.md');
    const linkPath = path.join(importsPath, 'linked.md');
    await fs.writeFile(outsidePath, songSource({ id: 'outside-song' }));
    await fs.symlink(outsidePath, linkPath);
    await assert.rejects(
      library.importFile(linkPath),
      expectLibraryCode('INVALID_IMPORT')
    );
  }
});

test('invalid UTF-8 is rejected both at import and when a checksum-valid stored revision is opened', async t => {
  const rootPath = await tempDirectory(t);
  const importsPath = await tempDirectory(t, 'syncshow-invalid-song-');
  const invalidBytes = Buffer.from([0xc3, 0x28]);
  const sourcePath = path.join(importsPath, 'invalid.md');
  await fs.writeFile(sourcePath, invalidBytes);
  const library = new LocalSongLibrary({ rootPath });

  await assert.rejects(library.importFile(sourcePath), expectLibraryCode('INVALID_IMPORT'));
  assert.deepEqual((await fs.readdir(rootPath)).filter(name => name.startsWith('song-')), []);

  const songId = 'invalid-utf8';
  const revision = crypto.createHash('sha256').update(invalidBytes).digest('hex');
  const songDirectory = path.join(rootPath, idStorageKey(songId));
  await fs.mkdir(path.join(songDirectory, 'versions'), { recursive: true });
  await fs.writeFile(path.join(songDirectory, 'versions', `${revision}.md`), invalidBytes);
  await fs.writeFile(path.join(songDirectory, 'current.json'), `${JSON.stringify({
    schemaVersion: 1,
    songId,
    revision,
    updatedAt: '2026-07-22T12:00:00.000Z'
  })}\n`);

  await assert.rejects(library.read(songId), expectLibraryCode('INVALID_UTF8'));
});

test('checksum tampering and symbolic-link replacement cannot be read as immutable song content', async t => {
  const rootPath = await tempDirectory(t);
  const library = new LocalSongLibrary({ rootPath });
  const saved = await library.saveSource(songSource());
  const versionPath = path.join(rootPath, idStorageKey(saved.song.id), 'versions', `${saved.revision}.md`);
  await fs.writeFile(versionPath, saved.source.replace('Amazing grace', 'Amazing fraud'));
  await assert.rejects(library.read(saved.song.id), expectLibraryCode('LIBRARY_REVISION_CORRUPT'));

  if (process.platform !== 'win32') {
    const second = await library.saveSource(songSource({ id: 'second-song', title: 'Second Song' }));
    const secondPath = path.join(rootPath, idStorageKey(second.song.id), 'versions', `${second.revision}.md`);
    const outsidePath = path.join(rootPath, 'outside-song.md');
    await fs.writeFile(outsidePath, second.source);
    await fs.unlink(secondPath);
    await fs.symlink(outsidePath, secondPath);
    await assert.rejects(library.read(second.song.id), expectLibraryCode('LIBRARY_REVISION_MISSING'));
  }
});

test('search covers multilingual title, author, tags, language, translation, sorting, and pagination', async t => {
  const rootPath = await tempDirectory(t);
  const library = new LocalSongLibrary({ rootPath, clock: () => new Date('2026-07-22T12:00:00.000Z') });
  await library.saveSource(songSource({
    id: 'blagodat',
    title: 'Благодать',
    language: 'ru',
    tags: ['милость', 'гимн'],
    authors: ['Иван Петров']
  }));
  await library.saveSource(songSource({
    id: 'amazing-grace',
    title: 'Amazing Grace',
    language: 'en',
    tags: ['hymn'],
    authors: ['John Newton'],
    translators: ['María Traductora'],
    composers: ['Virginia Harmony'],
    license: 'Public domain',
    source: 'Olney Hymns',
    attribution: 'Words by John Newton'
  }));
  await library.saveSource(songSource({
    id: 'grace-es',
    title: 'Gracia Asombrosa',
    language: 'es',
    translationOf: 'amazing-grace',
    tags: ['hymn'],
    authors: ['John Newton']
  }));

  assert.deepEqual((await library.list({ query: 'ИВАН милость' })).items.map(item => item.id), ['blagodat']);
  assert.deepEqual((await library.list({ query: 'newton hymn', language: 'es' })).items.map(item => item.id), ['grace-es']);
  assert.deepEqual((await library.list({ query: 'olney public' })).items.map(item => item.id), ['amazing-grace']);
  assert.deepEqual((await library.list({ query: 'maría harmony' })).items.map(item => item.id), ['amazing-grace']);
  assert.deepEqual((await library.list({ query: 'words newton' })).items.map(item => item.id), ['amazing-grace']);
  assert.equal((await library.read('amazing-grace')).song.attribution, 'Words by John Newton');
  assert.equal((await library.list({ query: 'olney' })).items[0].attribution, 'Words by John Newton');
  assert.deepEqual((await library.list({ query: 'olney' })).items[0].translators, ['María Traductora']);
  assert.deepEqual((await library.list({ query: 'olney' })).items[0].composers, ['Virginia Harmony']);
  assert.deepEqual((await library.list({ translationOf: 'amazing-grace' })).items.map(item => item.id), ['grace-es']);

  const firstPage = await library.list({ pageSize: 2 });
  assert.deepEqual(firstPage.items.map(item => item.title), ['Amazing Grace', 'Gracia Asombrosa']);
  assert.equal(firstPage.total, 3);
  assert.equal(firstPage.nextOffset, 2);
  const secondPage = await library.list({ pageSize: 2, offset: firstPage.nextOffset });
  assert.deepEqual(secondPage.items.map(item => item.title), ['Благодать']);
  assert.equal(secondPage.nextOffset, null);

  assert.equal((await library.list({ pageSize: MAX_PAGE_SIZE + 500 })).items.length, 3);
  await assert.rejects(
    library.list({ query: 'x'.repeat(121) }),
    expectLibraryCode('QUERY_TOO_LONG')
  );
});

test('listing omits corrupt entries without rewriting or deleting diagnostic evidence', async t => {
  const rootPath = await tempDirectory(t);
  const library = new LocalSongLibrary({ rootPath });
  const saved = await library.saveSource(songSource());
  const pointerPath = path.join(rootPath, idStorageKey(saved.song.id), 'current.json');
  await fs.writeFile(pointerPath, '{ definitely not json }\n');
  const before = await fs.readFile(pointerPath, 'utf8');

  assert.deepEqual(await library.list(), { items: [], total: 0, offset: 0, nextOffset: null });
  assert.equal(await fs.readFile(pointerPath, 'utf8'), before);
  await assert.rejects(library.read(saved.song.id), expectLibraryCode('LIBRARY_POINTER_INVALID'));
});

test('listing rejects a pointer whose song identity does not match its containing directory', async t => {
  const rootPath = await tempDirectory(t);
  const library = new LocalSongLibrary({ rootPath });
  const first = await library.saveSource(songSource({
    id: 'pointer-first',
    title: 'Pointer First'
  }));
  const second = await library.saveSource(songSource({
    id: 'pointer-second',
    title: 'Pointer Second'
  }));
  const mismatchedPointerPath = path.join(
    rootPath,
    idStorageKey(second.song.id),
    'current.json'
  );
  const mismatchedPointer = `${JSON.stringify({
    schemaVersion: 1,
    songId: first.song.id,
    revision: first.revision,
    updatedAt: '2026-07-22T12:00:00.000Z'
  })}\n`;
  await fs.writeFile(mismatchedPointerPath, mismatchedPointer);

  const listed = await library.list();
  assert.deepEqual(listed.items.map(item => item.id), [first.song.id]);
  assert.equal(listed.total, 1);
  assert.equal(await fs.readFile(mismatchedPointerPath, 'utf8'), mismatchedPointer);
});
