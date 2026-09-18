'use strict';

const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const test = require('node:test');

const {
  LocalSongLibrary,
  SongLibraryError,
  idStorageKey
} = require('../src/services/project/LocalSongLibrary');
const {
  DurableFamilyJournal
} = require('../src/services/project/DurableFamilyJournal');

async function tempDirectory(t) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'syncshow-song-family-transaction-')
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return fs.realpath(directory);
}

function songSource({
  id,
  title,
  language,
  translationOf = null,
  body
}) {
  const metadata = [
    '---',
    `id: ${id}`,
    `title: ${JSON.stringify(title)}`,
    `language: ${language}`
  ];
  if (translationOf) metadata.push(`translationOf: ${translationOf}`);
  return `${metadata.join('\n')}\n---\n\n${body}\n`;
}

function familySources(suffix = '') {
  return [
    {
      expectedSongId: 'reviewed-family',
      documentSource: songSource({
        id: 'reviewed-family',
        title: 'Reviewed Family',
        language: 'en',
        body: `^p1\nRoot one${suffix}\n\n^p2\nRoot two`
      })
    },
    {
      expectedSongId: 'reviewed-family-ru',
      documentSource: songSource({
        id: 'reviewed-family-ru',
        title: 'Проверенная песня',
        language: 'ru',
        translationOf: 'reviewed-family',
        body: `^p1\nПервая строка${suffix}\n\n^p2\nВторая строка`
      })
    },
    {
      expectedSongId: 'reviewed-family-es',
      documentSource: songSource({
        id: 'reviewed-family-es',
        title: 'Canción revisada',
        language: 'es',
        translationOf: 'reviewed-family',
        body: `^p1\nPrimera línea${suffix}\n\n^p2\nSegunda línea`
      })
    }
  ];
}

function expectCode(code) {
  return error => {
    assert.ok(error instanceof SongLibraryError);
    assert.equal(error.code, code);
    return true;
  };
}

async function commitFamilyInSession(
  library,
  recoveryAuthority,
  expectedSnapshot,
  documents
) {
  return library.withFamilyCommitSession(async session => {
    const staged = await session.stageFamily({
      familyId: 'reviewed-family',
      expectedSnapshot,
      documents
    });
    const promoted = [];
    for (const member of staged.members) {
      promoted.push(await session.promoteRevision(
        member.songId,
        member.afterRevision,
        {
          expectedRevision: member.beforeRevision,
          updatedAt: '2026-07-28T12:00:00.000Z'
        }
      ));
    }
    return { staged, promoted };
  }, { recoveryAuthority });
}

test('one exclusive session stages and promotes an exact multilingual family', async t => {
  const rootPath = await tempDirectory(t);
  const recoveryAuthority = Symbol('test-family-recovery');
  const library = new LocalSongLibrary({ rootPath, familyRecoveryAuthority: recoveryAuthority });
  const expected = await library.withCurrentSnapshot(session =>
    session.snapshotFamily('reviewed-family'));

  assert.equal(expected.familyRevision, null);
  assert.deepEqual(expected.documents, []);
  const committed = await commitFamilyInSession(
    library,
    recoveryAuthority,
    expected,
    familySources()
  );

  assert.equal(committed.staged.members.length, 3);
  assert.match(committed.staged.nextFamilyRevision, /^[a-f0-9]{64}$/);
  assert.equal(committed.promoted.every(item => item.unchanged === false), true);
  const final = await library.withCurrentSnapshot(session =>
    session.snapshotFamily('reviewed-family'));
  assert.equal(final.familyRevision, committed.staged.nextFamilyRevision);
  assert.deepEqual(
    final.documents.map(document => document.songId),
    ['reviewed-family', 'reviewed-family-es', 'reviewed-family-ru']
  );
});

test('a complete-family snapshot detects an untouched third translation changing', async t => {
  const rootPath = await tempDirectory(t);
  const recoveryAuthority = Symbol('test-family-recovery');
  const library = new LocalSongLibrary({ rootPath, familyRecoveryAuthority: recoveryAuthority });
  const empty = await library.withCurrentSnapshot(session =>
    session.snapshotFamily('reviewed-family'));
  await commitFamilyInSession(library, recoveryAuthority, empty, familySources());
  const reviewed = await library.withCurrentSnapshot(session =>
    session.snapshotFamily('reviewed-family'));
  const spanish = await library.read('reviewed-family-es');
  await library.saveSource(songSource({
    id: 'reviewed-family-es',
    title: 'Canción revisada',
    language: 'es',
    translationOf: 'reviewed-family',
    body: '^p1\nCambio concurrente\n\n^p2\nSegunda línea'
  }), {
    expectedSongId: spanish.song.id,
    expectedRevision: spanish.revision
  });

  await assert.rejects(
    library.withFamilyCommitSession(session => session.stageFamily({
      familyId: 'reviewed-family',
      expectedSnapshot: reviewed,
      documents: familySources(' reviewed')
    }), { recoveryAuthority }),
    expectCode('SONG_FAMILY_CONFLICT')
  );
});

test('complete-family snapshots fail closed when an untouched translation pointer is corrupt', async t => {
  const rootPath = await tempDirectory(t);
  const recoveryAuthority = Symbol('test-family-recovery');
  const library = new LocalSongLibrary({
    rootPath,
    familyRecoveryAuthority: recoveryAuthority
  });
  const empty = await library.withCurrentSnapshot(session =>
    session.snapshotFamily('reviewed-family'));
  await commitFamilyInSession(library, recoveryAuthority, empty, familySources());
  await fs.writeFile(
    path.join(
      rootPath,
      idStorageKey('reviewed-family-es'),
      'current.json'
    ),
    '{not valid JSON}\n',
    { mode: 0o600 }
  );

  const searchable = await library.list({ pageSize: 100 });
  assert.equal(
    searchable.items.some(item => item.id === 'reviewed-family-es'),
    false
  );
  await assert.rejects(
    library.withCurrentSnapshot(session =>
      session.snapshotFamily('reviewed-family')),
    expectCode('LIBRARY_POINTER_INVALID')
  );
  await assert.rejects(
    library.snapshotAllCurrent(),
    expectCode('LIBRARY_POINTER_INVALID')
  );
});

test('complete-family snapshots fail closed when a saved member pointer disappears', async t => {
  const rootPath = await tempDirectory(t);
  const recoveryAuthority = Symbol('test-family-recovery');
  const library = new LocalSongLibrary({
    rootPath,
    familyRecoveryAuthority: recoveryAuthority
  });
  const empty = await library.withCurrentSnapshot(session =>
    session.snapshotFamily('reviewed-family'));
  await commitFamilyInSession(library, recoveryAuthority, empty, familySources());
  await fs.unlink(path.join(
    rootPath,
    idStorageKey('reviewed-family-es'),
    'current.json'
  ));

  await assert.rejects(
    library.withCurrentSnapshot(session =>
      session.snapshotFamily('reviewed-family')),
    expectCode('LIBRARY_POINTER_INVALID')
  );
  await assert.rejects(
    library.snapshotAllCurrent(),
    expectCode('LIBRARY_POINTER_INVALID')
  );
});

test('complete-family snapshots reject noncanonical pointer metadata', async t => {
  const rootPath = await tempDirectory(t);
  const recoveryAuthority = Symbol('test-family-recovery');
  const library = new LocalSongLibrary({
    rootPath,
    familyRecoveryAuthority: recoveryAuthority
  });
  const empty = await library.withCurrentSnapshot(session =>
    session.snapshotFamily('reviewed-family'));
  await commitFamilyInSession(library, recoveryAuthority, empty, familySources());
  const pointerPath = path.join(
    rootPath,
    idStorageKey('reviewed-family-es'),
    'current.json'
  );
  const pointer = JSON.parse(await fs.readFile(pointerPath, 'utf8'));
  await fs.writeFile(
    pointerPath,
    `${JSON.stringify({
      ...pointer,
      updatedAt: 'not-a-canonical-timestamp',
      unexpected: true
    })}\n`,
    { mode: 0o600 }
  );

  await assert.rejects(
    library.withCurrentSnapshot(session =>
      session.snapshotFamily('reviewed-family')),
    expectCode('LIBRARY_POINTER_INVALID')
  );
  await assert.rejects(
    library.snapshotAllCurrent(),
    expectCode('LIBRARY_POINTER_INVALID')
  );
});

test('complete-family snapshots reject a member storage entry replaced by a non-directory', async t => {
  const rootPath = await tempDirectory(t);
  const recoveryAuthority = Symbol('test-family-recovery');
  const library = new LocalSongLibrary({
    rootPath,
    familyRecoveryAuthority: recoveryAuthority
  });
  const empty = await library.withCurrentSnapshot(session =>
    session.snapshotFamily('reviewed-family'));
  await commitFamilyInSession(library, recoveryAuthority, empty, familySources());
  const memberPath = path.join(
    rootPath,
    idStorageKey('reviewed-family-es')
  );
  await fs.rename(memberPath, `${memberPath}.quarantined-for-test`);
  await fs.writeFile(memberPath, 'not a song directory\n', { mode: 0o600 });

  assert.equal(
    (await library.list({ pageSize: 100 })).items.some(item =>
      item.id === 'reviewed-family-es'),
    false
  );
  await assert.rejects(
    library.withCurrentSnapshot(session =>
      session.snapshotFamily('reviewed-family')),
    expectCode('LIBRARY_POINTER_INVALID')
  );
  await assert.rejects(
    library.snapshotAllCurrent(),
    expectCode('LIBRARY_POINTER_INVALID')
  );
});

test('joint validation compares every translation to the proposed root', async t => {
  const rootPath = await tempDirectory(t);
  const recoveryAuthority = Symbol('test-family-recovery');
  const library = new LocalSongLibrary({ rootPath, familyRecoveryAuthority: recoveryAuthority });
  const empty = await library.withCurrentSnapshot(session =>
    session.snapshotFamily('reviewed-family'));
  await commitFamilyInSession(library, recoveryAuthority, empty, familySources());
  const reviewed = await library.withCurrentSnapshot(session =>
    session.snapshotFamily('reviewed-family'));
  const proposed = familySources();
  proposed[0] = {
    expectedSongId: 'reviewed-family',
    documentSource: songSource({
      id: 'reviewed-family',
      title: 'Reviewed Family',
      language: 'en',
      body: '^p1\nOnly one proposed section'
    })
  };

  await assert.rejects(
    library.withFamilyCommitSession(session => session.stageFamily({
      familyId: 'reviewed-family',
      expectedSnapshot: reviewed,
      documents: proposed
    }), { recoveryAuthority }),
    expectCode('SONG_FAMILY_STRUCTURE_MISMATCH')
  );
  assert.equal(
    (await library.withCurrentSnapshot(session =>
      session.snapshotFamily('reviewed-family'))).familyRevision,
    reviewed.familyRevision
  );
});

test('pending family evidence blocks current operations but not immutable reads or recovery sessions', async t => {
  const rootPath = await tempDirectory(t);
  const recoveryAuthority = Symbol('test-family-recovery');
  const library = new LocalSongLibrary({ rootPath, familyRecoveryAuthority: recoveryAuthority });
  const saved = await library.saveSource(familySources()[0].documentSource, {
    expectedRevision: null
  });
  await new DurableFamilyJournal({ rootPath }).write({
    schemaVersion: 1,
    kind: 'test-pending-family'
  });

  await assert.rejects(
    library.read(saved.song.id),
    expectCode('SONG_FAMILY_RECOVERY_REQUIRED')
  );
  assert.equal(
    (await library.read(saved.song.id, { revision: saved.revision })).revision,
    saved.revision
  );
  const recoveredRead = await library.withFamilyCommitSession(
    session => session.readCurrent(saved.song.id),
    { recoveryAuthority }
  );
  assert.equal(recoveredRead.revision, saved.revision);
});

test('current reads queue behind an in-process family session', async t => {
  const rootPath = await tempDirectory(t);
  const library = new LocalSongLibrary({ rootPath });
  const saved = await library.saveSource(familySources()[0].documentSource, {
    expectedRevision: null
  });
  let release;
  const held = new Promise(resolve => {
    release = resolve;
  });
  let entered;
  const didEnter = new Promise(resolve => {
    entered = resolve;
  });
  const transaction = library.withCurrentSnapshot(async () => {
    entered();
    await held;
  });
  await didEnter;

  let readSettled = false;
  const read = library.read(saved.song.id).finally(() => {
    readSettled = true;
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(readSettled, false);
  release();
  await transaction;
  assert.equal((await read).revision, saved.revision);
});
