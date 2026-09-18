'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  CommunitySermonMediaAttemptStore,
  sermonMediaAttemptBindingKey,
  sermonMediaAttemptRecoveryLocator
} = require('../src/services/community/CommunitySermonMediaAttemptStore');

const UUIDS = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333'
];

async function tempDirectory(t) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'syncshow-sermon-media-attempt-')
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return fs.realpath(directory);
}

function store(rootPath, start = 0) {
  let index = start;
  return new CommunitySermonMediaAttemptStore({
    rootPath,
    randomUUID: () => UUIDS[index++],
    now: () => new Date('2026-08-02T18:30:00.000Z')
  });
}

function binding(overrides = {}) {
  return {
    projectId: 'project-one',
    projectRevisionId: '1'.repeat(64),
    itemId: 'sermon-item-one',
    sermonId: 'sermon:2026-08-02:romans-8',
    sermonRevisionId: 'a'.repeat(64),
    expectedSyncVersion: 7,
    expectedCurrentRevision: 'a'.repeat(64),
    recording: {
      id: 'post-service:recording:en',
      kind: 'audio',
      language: 'en',
      mediaType: 'audio/mpeg',
      fileName: 'sermon.mp3',
      sha256: 'b'.repeat(64),
      sizeBytes: 8_388_614,
      durationSeconds: null
    },
    ...overrides
  };
}

function recoveryBinding(value = binding()) {
  return {
    sermonId: value.sermonId,
    expectedSyncVersion: value.expectedSyncVersion,
    expectedCurrentRevision: value.expectedCurrentRevision,
    recording: { ...value.recording }
  };
}

const identity = Object.freeze({
  serverId: 'https://community.example.test/',
  communityId: 'wotbc'
});

test('attempt identity persists and successful replay survives app restart', async t => {
  const root = await tempDirectory(t);
  const key = sermonMediaAttemptBindingKey(binding(), identity);
  const first = await store(root).attemptFor(key, {
    rotateTerminal: true
  });

  const restarted = store(root, 1);
  const replay = await restarted.attemptFor(key, {
    // Start uses this after restart. An unmarked successful attempt must keep
    // the exact init key so Community can replay the completed private slot.
    rotateTerminal: true
  });
  assert.equal(replay.attemptId, first.attemptId);
  assert.equal(replay.uploadId, null);
  assert.deepEqual(replay.locatorKeys, []);
  assert.equal(replay.terminal, false);
});

test('acknowledged upload identity survives restart and mismatches fail closed', async t => {
  const root = await tempDirectory(t);
  const key = sermonMediaAttemptBindingKey(binding(), identity);
  const attempts = store(root);
  const first = await attempts.attemptFor(key);
  const uploadId = 'ABCDEFGHIJKLMNOPQRSTUVWX12345678';

  const acknowledged = await attempts.acknowledgeUpload(
    key,
    first.attemptId,
    uploadId
  );
  assert.equal(acknowledged.changed, true);
  assert.equal(acknowledged.attempt.uploadId, uploadId);

  const replay = await store(root, 1).readAttempt(key);
  assert.equal(replay.attemptId, first.attemptId);
  assert.equal(replay.uploadId, uploadId);
  assert.equal(replay.terminal, false);

  const idempotent = await attempts.acknowledgeUpload(
    key,
    first.attemptId,
    uploadId
  );
  assert.equal(idempotent.changed, false);
  await assert.rejects(
    attempts.acknowledgeUpload(
      key,
      first.attemptId,
      'ZYXWVUTSRQPONMLKJIHGFEDC87654321'
    ),
    /changed the upload identity/
  );
});

test('legacy attempt files migrate without inventing an upload identity', async t => {
  const root = await tempDirectory(t);
  const key = sermonMediaAttemptBindingKey(binding(), identity);
  await fs.writeFile(
    path.join(root, 'attempts.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      attempts: {
        [key]: {
          attemptId: UUIDS[0],
          terminal: false,
          updatedAt: '2026-08-02T18:30:00.000Z'
        }
      }
    }, null, 2)}\n`,
    { mode: 0o600 }
  );

  const attempts = store(root, 1);
  const legacy = await attempts.readAttempt(key);
  assert.equal(legacy.attemptId, UUIDS[0]);
  assert.equal(legacy.uploadId, null);
  assert.deepEqual(legacy.locatorKeys, []);
  await attempts.acknowledgeUpload(
    key,
    UUIDS[0],
    'ABCDEFGHIJKLMNOPQRSTUVWX12345678'
  );
  const migrated = JSON.parse(
    await fs.readFile(path.join(root, 'attempts.json'), 'utf8')
  );
  assert.equal(migrated.schemaVersion, 3);
  assert.equal(
    migrated.attempts[key].uploadId,
    'ABCDEFGHIJKLMNOPQRSTUVWX12345678'
  );
});

test('project-item locators recover acknowledged attempts after binding drift', async t => {
  const root = await tempDirectory(t);
  const exact = sermonMediaAttemptBindingKey(binding(), identity);
  const locator = sermonMediaAttemptRecoveryLocator(binding(), identity);
  const attempts = store(root);
  const first = await attempts.attemptFor(exact, {
    recoveryLocator: locator,
    recoveryBinding: recoveryBinding()
  });
  await attempts.acknowledgeUpload(
    exact,
    first.attemptId,
    'ABCDEFGHIJKLMNOPQRSTUVWX12345678'
  );

  const changed = binding({
    sermonId: 'sermon:2026-08-09:romans-9',
    sermonRevisionId: 'c'.repeat(64),
    expectedCurrentRevision: 'c'.repeat(64),
    recording: {
      ...binding().recording,
      sha256: 'd'.repeat(64)
    }
  });
  assert.notEqual(
    sermonMediaAttemptBindingKey(changed, identity),
    exact
  );
  assert.equal(
    sermonMediaAttemptRecoveryLocator(changed, identity),
    locator
  );

  const recovered = await store(root, 1).readRecoverable(locator);
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].attemptKey, exact);
  assert.equal(
    recovered[0].uploadId,
    'ABCDEFGHIJKLMNOPQRSTUVWX12345678'
  );
  await attempts.markTerminal(exact, first.attemptId);
  assert.deepEqual(await attempts.readRecoverable(locator), []);
});

test('cancelled, expired, or superseded attempts rotate only after terminal mark', async t => {
  const root = await tempDirectory(t);
  const attempts = store(root);
  const key = sermonMediaAttemptBindingKey(binding(), identity);
  const first = await attempts.attemptFor(key);

  const marked = await attempts.markTerminal(key, first.attemptId);
  assert.equal(marked.changed, true);
  assert.equal(marked.attempt.terminal, true);

  const ordinaryReplay = await attempts.attemptFor(key);
  assert.equal(ordinaryReplay.attemptId, first.attemptId);
  assert.equal(ordinaryReplay.terminal, true);

  const restarted = await attempts.attemptFor(key, {
    rotateTerminal: true
  });
  assert.equal(restarted.attemptId, UUIDS[1]);
  assert.equal(restarted.uploadId, null);
  assert.deepEqual(restarted.locatorKeys, []);
  assert.equal(restarted.terminal, false);
});

test('attempt binding follows server, Community, sermon revision, and exact recording', () => {
  const first = sermonMediaAttemptBindingKey(binding(), identity);
  const anotherProject = sermonMediaAttemptBindingKey(binding({
    projectId: 'project-two',
    projectRevisionId: '2'.repeat(64),
    itemId: 'another-sermon-cue'
  }), identity);
  assert.equal(
    anotherProject,
    first,
    'two service projects referencing the exact sermon recording share resume identity'
  );

  assert.notEqual(
    sermonMediaAttemptBindingKey(binding(), {
      ...identity,
      serverId: 'https://another-appliance.example.test/'
    }),
    first
  );
  assert.notEqual(
    sermonMediaAttemptBindingKey(binding(), {
      ...identity,
      communityId: 'another-church'
    }),
    first,
    'two communities on one appliance must never share upload attempts'
  );
  assert.notEqual(
    sermonMediaAttemptBindingKey(binding({
      recording: {
        ...binding().recording,
        sha256: 'c'.repeat(64)
      }
    }), identity),
    first
  );
});

test('recovery locator follows server, Community, project, and item but not revision', () => {
  const first = sermonMediaAttemptRecoveryLocator(binding(), identity);
  assert.equal(
    sermonMediaAttemptRecoveryLocator(binding({
      projectRevisionId: '2'.repeat(64),
      sermonRevisionId: 'c'.repeat(64),
      expectedCurrentRevision: 'c'.repeat(64),
      recording: {
        ...binding().recording,
        sha256: 'd'.repeat(64)
      }
    }), identity),
    first
  );
  assert.notEqual(
    sermonMediaAttemptRecoveryLocator(binding({
      projectId: 'project-two'
    }), identity),
    first
  );
  assert.notEqual(
    sermonMediaAttemptRecoveryLocator(binding({
      itemId: 'another-sermon'
    }), identity),
    first
  );
  assert.notEqual(
    sermonMediaAttemptRecoveryLocator(binding(), {
      ...identity,
      communityId: 'another-church'
    }),
    first
  );
});

test('byte-bound pruning preserves every active recovery attempt', async t => {
  const root = await tempDirectory(t);
  const activeKey = 'f'.repeat(64);
  const locator = sermonMediaAttemptRecoveryLocator(binding(), identity);
  const activeAttempt = {
    attemptId: UUIDS[2],
    uploadId: 'ABCDEFGHIJKLMNOPQRSTUVWX12345678',
    binding: recoveryBinding(),
    locatorKeys: [locator],
    terminal: false,
    updatedAt: '2026-08-02T18:30:00.000Z'
  };
  const terminalEntries = Array.from({ length: 6_000 }, (_, index) => [
    require('node:crypto')
      .createHash('sha256')
      .update(`terminal-${index}`)
      .digest('hex'),
    {
      attemptId: UUIDS[index % UUIDS.length],
      uploadId: null,
      binding: null,
      locatorKeys: [],
      terminal: true,
      updatedAt: new Date(
        Date.parse('2026-01-01T00:00:00.000Z') + index
      ).toISOString()
    }
  ]);
  const sourceFor = count => `${JSON.stringify({
    schemaVersion: 3,
    attempts: Object.fromEntries([
      [activeKey, activeAttempt],
      ...terminalEntries.slice(0, count)
    ])
  }, null, 2)}\n`;
  let lower = 0;
  let upper = terminalEntries.length;
  while (lower < upper) {
    const middle = Math.ceil((lower + upper) / 2);
    if (Buffer.byteLength(sourceFor(middle)) <= 1024 * 1024 - 256) {
      lower = middle;
    } else {
      upper = middle - 1;
    }
  }
  const initialSource = sourceFor(lower);
  await fs.writeFile(
    path.join(root, 'attempts.json'),
    initialSource,
    { mode: 0o600 }
  );

  const nextBinding = binding({
    sermonId: 'sermon:2026-08-09:romans-9',
    sermonRevisionId: 'c'.repeat(64),
    expectedCurrentRevision: 'c'.repeat(64),
    recording: {
      ...binding().recording,
      sha256: 'd'.repeat(64)
    }
  });
  const nextKey = sermonMediaAttemptBindingKey(nextBinding, identity);
  await store(root).attemptFor(nextKey, {
    recoveryLocator: locator,
    recoveryBinding: recoveryBinding(nextBinding)
  });

  const savedSource = await fs.readFile(
    path.join(root, 'attempts.json'),
    'utf8'
  );
  const saved = JSON.parse(savedSource);
  assert.ok(Buffer.byteLength(savedSource) <= 1024 * 1024);
  assert.ok(saved.attempts[activeKey]);
  assert.ok(saved.attempts[nextKey]);
  assert.equal(saved.attempts[activeKey].terminal, false);
  assert.equal(saved.attempts[nextKey].terminal, false);
  assert.ok(
    Object.keys(saved.attempts).length
      < lower + 2,
    'only terminal history may be trimmed to make byte room'
  );
});
