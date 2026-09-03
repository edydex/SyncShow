'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const {
  FAMILY_JOURNAL_CLEAR_KIND,
  FAMILY_JOURNAL_FILE,
  FAMILY_JOURNAL_HIGH_WATER_FILE,
  FAMILY_JOURNAL_PROVISION_MARKER_FILE,
  SLOT_BYTES,
  SLOT_HEADER_BYTES,
  DurableFamilyJournal
} = require('../src/services/project/DurableFamilyJournal');
const {
  LocalSongLibrary
} = require('../src/services/project/LocalSongLibrary');

async function temporaryRoot(t) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'syncshow-family-journal-')
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

const pendingRecord = Object.freeze({
  schemaVersion: 1,
  kind: 'test-pending-family'
});

test('a raw os.tmpdir library path provisions one permanent clear journal', async t => {
  const root = await temporaryRoot(t);
  const library = new LocalSongLibrary({
    rootPath: path.join(root, 'songs')
  });
  const saved = await library.saveSource(
    '---\nid: raw-temp-song\ntitle: Raw Temp Song\nlanguage: en\n---\n\n^1\nLine\n'
  );

  assert.equal(saved.song.id, 'raw-temp-song');
  const realLibraryRoot = await fs.realpath(path.join(root, 'songs'));
  const active = await new DurableFamilyJournal({
    rootPath: realLibraryRoot
  }).read();
  assert.equal(active.clear, true);
  await fs.access(path.join(realLibraryRoot, FAMILY_JOURNAL_FILE));
  await fs.access(path.join(
    realLibraryRoot,
    FAMILY_JOURNAL_HIGH_WATER_FILE
  ));
  await fs.access(path.join(
    realLibraryRoot,
    FAMILY_JOURNAL_PROVISION_MARKER_FILE
  ));
});

test('a torn unacknowledged transaction slot leaves the witnessed clear active', async t => {
  const root = await temporaryRoot(t);
  const journal = new DurableFamilyJournal({ rootPath: root });
  assert.equal((await journal.read()).generation, 1);
  const handle = await fs.open(path.join(root, FAMILY_JOURNAL_FILE), 'r+');
  try {
    await handle.write(Buffer.from('partial transaction'), 0, 19, SLOT_BYTES);
    await handle.sync();
  } finally {
    await handle.close();
  }

  const active = await journal.read();
  assert.equal(active.generation, 1);
  assert.equal(active.clear, true);
});

test('a torn unacknowledged clear leaves the witnessed transaction active', async t => {
  const root = await temporaryRoot(t);
  const journal = new DurableFamilyJournal({ rootPath: root });
  const pending = await journal.write(pendingRecord);
  assert.equal(pending.generation, 2);
  const handle = await fs.open(path.join(root, FAMILY_JOURNAL_FILE), 'r+');
  try {
    await handle.write(Buffer.from('partial clear'), 0, 13, 0);
    await handle.sync();
  } finally {
    await handle.close();
  }

  const active = await journal.read();
  assert.equal(active.generation, 2);
  assert.equal(active.record.kind, pendingRecord.kind);
});

test('corrupting an acknowledged pending slot cannot fall back to an older clear', async t => {
  const root = await temporaryRoot(t);
  const journal = new DurableFamilyJournal({ rootPath: root });
  await journal.write(pendingRecord);
  const journalPath = path.join(root, FAMILY_JOURNAL_FILE);
  const handle = await fs.open(journalPath, 'r+');
  try {
    const byte = Buffer.alloc(1);
    const offset = SLOT_BYTES + SLOT_HEADER_BYTES;
    await handle.read(byte, 0, 1, offset);
    byte[0] ^= 0xff;
    await handle.write(byte, 0, 1, offset);
    await handle.sync();
  } finally {
    await handle.close();
  }

  await assert.rejects(
    journal.read(),
    error => error.code === 'FAMILY_JOURNAL_CORRUPT'
  );
});

test('a provisioned journal deletion fails closed and is never bootstrapped as clear', async t => {
  const root = await temporaryRoot(t);
  const journal = new DurableFamilyJournal({ rootPath: root });
  await journal.write(pendingRecord);
  const journalPath = path.join(root, FAMILY_JOURNAL_FILE);
  await fs.unlink(journalPath);

  await assert.rejects(
    journal.read(),
    error => error.code === 'FAMILY_JOURNAL_MISSING'
  );
  await assert.rejects(
    fs.access(journalPath),
    error => error.code === 'ENOENT'
  );
});

test('a corrupted high-water witness never falls back to an older clear slot', async t => {
  const root = await temporaryRoot(t);
  const journal = new DurableFamilyJournal({ rootPath: root });
  await journal.write(pendingRecord);
  const highWaterPath = path.join(root, FAMILY_JOURNAL_HIGH_WATER_FILE);
  const handle = await fs.open(highWaterPath, 'r+');
  try {
    await handle.write(Buffer.alloc(64), 0, 64, 0);
    await handle.sync();
  } finally {
    await handle.close();
  }

  await assert.rejects(
    journal.read(),
    error => error.code === 'FAMILY_JOURNAL_CORRUPT'
  );
});

test('replaying an older valid witness advances to the newer durable pending slot', async t => {
  const root = await temporaryRoot(t);
  const journal = new DurableFamilyJournal({ rootPath: root });
  const initial = await journal.read();
  assert.equal(initial.clear, true);
  const highWaterPath = path.join(root, FAMILY_JOURNAL_HIGH_WATER_FILE);
  const priorWitness = await fs.readFile(highWaterPath);

  const pending = await journal.write(pendingRecord);
  assert.equal(pending.generation, initial.generation + 1);
  const handle = await fs.open(highWaterPath, 'r+');
  try {
    await handle.write(priorWitness, 0, priorWitness.length, 0);
    await handle.sync();
  } finally {
    await handle.close();
  }

  const recovered = await journal.read();
  assert.equal(recovered.generation, pending.generation);
  assert.equal(recovered.clear, false);
  assert.deepEqual(recovered.record, pendingRecord);
  assert.notDeepEqual(await fs.readFile(highWaterPath), priorWitness);
});

test('replaying one older valid slot cannot create a gapped journal history', async t => {
  const root = await temporaryRoot(t);
  const journal = new DurableFamilyJournal({ rootPath: root });
  await journal.read();
  await journal.write(pendingRecord);
  const journalPath = path.join(root, FAMILY_JOURNAL_FILE);
  const generationOneSlot = (await fs.readFile(journalPath))
    .subarray(0, SLOT_BYTES);
  await journal.clear();
  await journal.write(pendingRecord);

  const handle = await fs.open(journalPath, 'r+');
  try {
    await handle.write(generationOneSlot, 0, generationOneSlot.length, 0);
    await handle.sync();
  } finally {
    await handle.close();
  }

  await assert.rejects(
    journal.read(),
    error => error.code === 'FAMILY_JOURNAL_CORRUPT'
  );
});

test('the permanent clear sentinel has one exact bounded shape', async t => {
  const root = await temporaryRoot(t);
  const journal = new DurableFamilyJournal({ rootPath: root });
  await journal.read();
  await assert.rejects(
    journal.write({
      schemaVersion: 1,
      kind: FAMILY_JOURNAL_CLEAR_KIND,
      extra: true
    }),
    error => error.code === 'FAMILY_JOURNAL_RECORD_INVALID'
  );
  assert.equal((await journal.read()).clear, true);
});
