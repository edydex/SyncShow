'use strict';

const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const test = require('node:test');

const {
  LocalSongFamilyReviewStore,
  LocalSongFamilyReviewStoreError,
  SONG_FAMILY_REVIEW_CONFIRMATION_AUTHORITY_SCOPE,
  SONG_FAMILY_REVIEW_RECEIPT_KIND,
  SONG_FAMILY_REVIEW_RECEIPT_SCHEMA_VERSION,
  SONG_FAMILY_REVIEW_SCOPE,
  SONG_FAMILY_REVIEW_SNAPSHOT_KIND,
  SONG_FAMILY_REVIEW_SNAPSHOT_SCHEMA_VERSION
} = require('../src/services/project/LocalSongFamilyReviewStore');
const {
  LocalSongFamilyCommitCoordinator
} = require('../src/services/project/LocalSongFamilyCommitCoordinator');
const {
  LocalSongLibrary
} = require('../src/services/project/LocalSongLibrary');
const {
  DurableFamilyJournal
} = require('../src/services/project/DurableFamilyJournal');
const {
  normalizeSongDocument,
  parseSongDocument,
  serializeSongDocument
} = require('../src/services/project/SongDocument');
const {
  songFamilyRevision
} = require('../src/services/project/SongFamilyRevision');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function clone(value) {
  return structuredClone(value);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function canonicalBytes(value) {
  return Buffer.from(`${canonicalJson(value)}\n`, 'utf8');
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

async function temporaryRoot(t) {
  const parent = await fs.mkdtemp(
    path.join(os.tmpdir(), 'syncshow-song-family-review-')
  );
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  return {
    parent: await fs.realpath(parent),
    rootPath: path.join(await fs.realpath(parent), 'review-store')
  };
}

function canonicalSong({
  id,
  title,
  language,
  translationOf = null,
  slideLines
}) {
  const song = normalizeSongDocument({
    schemaVersion: 1,
    id,
    title,
    language,
    translationOf,
    license: '',
    tags: [],
    authors: [],
    translators: [],
    composers: [],
    source: 'Reviewed local PowerPoint',
    attribution: '',
    extraMetadata: {},
    sections: slideLines.map((lines, index) => ({
      id: `p${index + 1}`,
      marker: `P${index + 1}`,
      label: `P${index + 1}`,
      slides: [{
        id: `p${index + 1}-slide-1`,
        lines
      }]
    }))
  });
  const documentSource = serializeSongDocument(song);
  return {
    documentSource,
    revision: sha256(Buffer.from(documentSource, 'utf8')),
    textSha256: sha256(Buffer.from(JSON.stringify(slideLines), 'utf8'))
  };
}

function capture({
  roleId,
  deckSha256,
  lines,
  ordinal = 1,
  lane = 'all',
  lanes = null,
  slideNumbers = null,
  selectionOrigin = 'template-local'
}) {
  const slides = lines.map((slideLines, index) => ({
    number: slideNumbers ? slideNumbers[index] : index + 2,
    lane: lanes ? lanes[index] : lane,
    lines: slideLines,
    textSha256: sha256(Buffer.from(JSON.stringify(slideLines), 'utf8'))
  }));
  return {
    ordinal,
    roleId,
    deckSha256,
    selectionOrigin,
    candidateId: selectionOrigin === 'template-local' ? 'slides-1-2-3' : null,
    titleSlide: selectionOrigin === 'template-local' ? 1 : null,
    capturedTextSha256: sha256(
      Buffer.from(JSON.stringify(lines), 'utf8')
    ),
    slides
  };
}

function tenOccurrenceSnapshot() {
  const sectionOrder = ['p1', 'p2', 'p3', 'p4', 'p1', 'p2', 'p3', 'p5', 'p3', 'p6'];
  const sectionIds = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'];
  const rootBySection = Object.fromEntries(
    sectionIds.map(sectionId => [sectionId, [`EN ${sectionId.toUpperCase()}`]])
  );
  const translationBySection = Object.fromEntries(
    sectionIds.map(sectionId => [sectionId, [`RU ${sectionId.toUpperCase()}`]])
  );
  const rootDocumentLines = sectionIds.map(sectionId =>
    rootBySection[sectionId]);
  const translationDocumentLines = sectionIds.map(sectionId =>
    translationBySection[sectionId]);
  const rootCaptureLines = sectionOrder.map(sectionId =>
    rootBySection[sectionId]);
  const translationCaptureLines = sectionOrder.map(sectionId =>
    translationBySection[sectionId]);
  const original = canonicalSong({
    id: 'july-family',
    title: 'July Family',
    language: 'en',
    slideLines: rootDocumentLines
  });
  const translation = canonicalSong({
    id: 'july-family-ru',
    title: 'Июльская песня',
    language: 'ru',
    translationOf: 'july-family',
    slideLines: translationDocumentLines
  });
  const deckSha256 = '9'.repeat(64);
  const slideNumbers = Array.from({ length: 10 }, (_, index) => index + 12);
  const rootLanes = slideNumbers.map((_, index) =>
    index < 4 ? 'yellow' : 'white');
  const translationLanes = slideNumbers.map((_, index) =>
    index < 4 ? 'white' : 'yellow');
  const firstOccurrenceBySection = new Map();
  const occurrences = sectionOrder.map((sectionId, index) => {
    const occurrenceId = `slide-${slideNumbers[index]}`;
    const first = firstOccurrenceBySection.get(sectionId);
    if (!first) firstOccurrenceBySection.set(sectionId, occurrenceId);
    return {
      occurrenceId,
      action: first ? 'repeat' : 'new',
      sectionId,
      repeatOfOccurrenceId: first || null,
      evidence: [{
        songId: 'july-family',
        captureOrdinal: 1,
        slideNumber: slideNumbers[index]
      }, {
        songId: 'july-family-ru',
        captureOrdinal: 1,
        slideNumber: slideNumbers[index]
      }]
    };
  });
  return {
    schemaVersion: 1,
    kind: SONG_FAMILY_REVIEW_SNAPSHOT_KIND,
    reviewScope: SONG_FAMILY_REVIEW_SCOPE,
    reviewedAt: '2026-07-28T12:00:00.000Z',
    serviceSet: {
      id: 'service-2026-07-26',
      fingerprint: '8'.repeat(64),
      serviceDate: '2026-07-26',
      profileId: 'heritage-main',
      extractor: {
        id: 'syncshow-current-service-pptx',
        version: 1
      },
      decks: [{
        roleId: 'bilingual',
        sourceName: '07-26-2026 Service ENG.pptx',
        sourceSizeBytes: 765_432,
        deckSha256,
        deckSlideCount: 45
      }]
    },
    family: {
      rootSongId: 'july-family',
      members: [{
        songId: 'july-family',
        familyRole: 'original',
        translationOf: null,
        action: 'create',
        expectedRevision: null,
        reviewedRevision: original.revision,
        finalTextSha256: original.textSha256,
        documentSource: original.documentSource,
        captures: [capture({
          roleId: 'bilingual',
          deckSha256,
          lines: rootCaptureLines,
          lanes: rootLanes,
          slideNumbers,
          selectionOrigin: 'manual'
        })]
      }, {
        songId: 'july-family-ru',
        familyRole: 'translation',
        translationOf: 'july-family',
        action: 'create',
        expectedRevision: null,
        reviewedRevision: translation.revision,
        finalTextSha256: translation.textSha256,
        documentSource: translation.documentSource,
        captures: [capture({
          roleId: 'bilingual',
          deckSha256,
          lines: translationCaptureLines,
          lanes: translationLanes,
          slideNumbers,
          selectionOrigin: 'manual'
        })]
      }],
      occurrences
    }
  };
}

function fixtureSnapshot({
  reviewedAt = '2026-07-28T12:00:00.000Z',
  serviceSetId = 'service-2026-07-28'
} = {}) {
  const rootLines = [['Root line one'], ['Root line two']];
  const translationLines = [['Первая строка'], ['Вторая строка']];
  const original = canonicalSong({
    id: 'captured-family',
    title: 'Captured Family',
    language: 'en',
    slideLines: rootLines
  });
  const translation = canonicalSong({
    id: 'captured-family-ru',
    title: 'Семья песни',
    language: 'ru',
    translationOf: 'captured-family',
    slideLines: translationLines
  });
  const englishDeck = 'a'.repeat(64);
  const russianDeck = 'b'.repeat(64);
  return {
    schemaVersion: 1,
    kind: SONG_FAMILY_REVIEW_SNAPSHOT_KIND,
    reviewScope: SONG_FAMILY_REVIEW_SCOPE,
    reviewedAt,
    serviceSet: {
      id: serviceSetId,
      fingerprint: 'c'.repeat(64),
      serviceDate: '2026-07-28',
      profileId: 'heritage-main',
      extractor: {
        id: 'syncshow-current-service-pptx',
        version: 1
      },
      decks: [{
        roleId: 'russian',
        sourceName: 'Service Slides Russian.pptx',
        sourceSizeBytes: 234_567,
        deckSha256: russianDeck,
        deckSlideCount: 40
      }, {
        roleId: 'english',
        sourceName: 'Service Slides.pptx',
        sourceSizeBytes: 123_456,
        deckSha256: englishDeck,
        deckSlideCount: 40
      }]
    },
    family: {
      rootSongId: 'captured-family',
      members: [{
        songId: 'captured-family-ru',
        familyRole: 'translation',
        translationOf: 'captured-family',
        action: 'create',
        expectedRevision: null,
        reviewedRevision: translation.revision,
        finalTextSha256: translation.textSha256,
        documentSource: translation.documentSource,
        captures: [capture({
          roleId: 'russian',
          deckSha256: russianDeck,
          lines: translationLines,
          lane: 'yellow'
        })]
      }, {
        songId: 'captured-family',
        familyRole: 'original',
        translationOf: null,
        action: 'create',
        expectedRevision: null,
        reviewedRevision: original.revision,
        finalTextSha256: original.textSha256,
        documentSource: original.documentSource,
        captures: [capture({
          roleId: 'english',
          deckSha256: englishDeck,
          lines: rootLines,
          lane: 'white'
        })]
      }],
      occurrences: [{
        occurrenceId: 'slide-2',
        action: 'new',
        sectionId: 'p1',
        repeatOfOccurrenceId: null,
        evidence: [{
          songId: 'captured-family-ru',
          captureOrdinal: 1,
          slideNumber: 2
        }, {
          songId: 'captured-family',
          captureOrdinal: 1,
          slideNumber: 2
        }]
      }, {
        occurrenceId: 'slide-3',
        action: 'new',
        sectionId: 'p2',
        repeatOfOccurrenceId: null,
        evidence: [{
          songId: 'captured-family',
          captureOrdinal: 1,
          slideNumber: 3
        }, {
          songId: 'captured-family-ru',
          captureOrdinal: 1,
          slideNumber: 3
        }]
      }]
    }
  };
}

function confirmedFixtureSnapshot(options = {}) {
  return {
    ...fixtureSnapshot(options),
    schemaVersion: 2,
    confirmations: {
      sourceConfirmed: true,
      rightsConfirmed: true,
      localCommitConfirmed: true,
      authorityScope: SONG_FAMILY_REVIEW_CONFIRMATION_AUTHORITY_SCOPE,
      communityAuthorityGranted: false
    }
  };
}

function currentFixtureSnapshot(options = {}) {
  const snapshot = confirmedFixtureSnapshot(options);
  snapshot.schemaVersion = SONG_FAMILY_REVIEW_SNAPSHOT_SCHEMA_VERSION;
  snapshot.family.members = snapshot.family.members.map((member, index) => {
    const song = parseSongDocument(member.documentSource, {
      fileName: `${member.songId}.md`
    });
    song.license = index === 0
      ? 'Direct translation permission'
      : 'CCLI service license';
    const documentSource = serializeSongDocument(song);
    return {
      ...member,
      reviewedRevision: sha256(Buffer.from(documentSource, 'utf8')),
      documentSource,
      localServiceRights: {
        scope: 'local-service-song-intake',
        basis: index === 0
          ? 'direct-permission'
          : 'ccli-service-license',
        evidence: index === 0
          ? 'Written translation permission reviewed for this local service.'
          : 'CCLI service license and exact SongSelect entry reviewed.',
        reviewedAt: snapshot.reviewedAt
      }
    };
  });
  return snapshot;
}

function receiptRequest(snapshotHash, snapshot, overrides = {}) {
  const familyRevision = songFamilyRevision(snapshot.family.members.map(member => ({
    song: parseSongDocument(member.documentSource, {
      fileName: `${member.songId}.md`
    }),
    revision: member.reviewedRevision
  })));
  return {
    snapshotHash,
    committedAt: '2026-07-28T13:00:00.000Z',
    familyRevision,
    results: snapshot.family.members.map(member => ({
      songId: member.songId,
      previousRevision: member.expectedRevision,
      resultingRevision: member.reviewedRevision
    })),
    ...overrides
  };
}

function serviceSetBinding(snapshot) {
  return {
    id: snapshot.serviceSet.id,
    fingerprint: snapshot.serviceSet.fingerprint,
    serviceDate: snapshot.serviceSet.serviceDate,
    profileId: snapshot.serviceSet.profileId
  };
}

function expectCode(code) {
  return error => {
    assert.ok(error instanceof LocalSongFamilyReviewStoreError);
    assert.equal(error.code, code);
    return true;
  };
}

async function jsonFiles(rootPath) {
  const files = [];
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
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        await visit(candidate);
      } else if (entry.isFile() && entry.name.endsWith('.json')) {
        files.push(candidate);
      }
    }
  }
  await visit(rootPath);
  return files.sort();
}

test('snapshots are canonical, deterministic, immutable, and owner-only', async t => {
  const first = await temporaryRoot(t);
  const second = await temporaryRoot(t);
  const snapshot = fixtureSnapshot();
  const firstStore = new LocalSongFamilyReviewStore({
    rootPath: first.rootPath
  });
  const secondStore = new LocalSongFamilyReviewStore({
    rootPath: second.rootPath
  });

  const saved = await firstStore.saveSnapshot(snapshot);
  const repeated = await firstStore.saveSnapshot(reverseObjectKeys(snapshot));
  const independent = await secondStore.saveSnapshot(reverseObjectKeys(snapshot));

  assert.equal(saved.unchanged, false);
  assert.equal(repeated.unchanged, true);
  assert.equal(independent.snapshotHash, saved.snapshotHash);
  assert.deepEqual(repeated.snapshot, saved.snapshot);
  assert.equal(Object.isFrozen(saved.snapshot), true);
  assert.equal(Object.isFrozen(saved.snapshot.family.members), true);
  assert.deepEqual(await firstStore.readSnapshot(saved.snapshotHash), saved.snapshot);

  const snapshotPath = path.join(
    first.rootPath,
    'snapshots',
    saved.snapshotHash.slice(0, 2),
    `${saved.snapshotHash}.json`
  );
  const bytes = await fs.readFile(snapshotPath);
  assert.ok(bytes.equals(canonicalBytes(saved.snapshot)));
  assert.equal(sha256(bytes), saved.snapshotHash);
  assert.equal(bytes.at(-1), 0x0a);

  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(first.rootPath)).mode & 0o077, 0);
    assert.equal((await fs.stat(path.dirname(snapshotPath))).mode & 0o077, 0);
    assert.equal((await fs.stat(snapshotPath)).mode & 0o077, 0);
  }
});

test('versions 1, 2, and 3 retain their exact evidence without synthesizing rights', async t => {
  const { rootPath } = await temporaryRoot(t);
  const store = new LocalSongFamilyReviewStore({ rootPath });

  const legacy = await store.saveSnapshot(fixtureSnapshot());
  const legacyReceipt = await store.saveCommitReceipt(
    receiptRequest(legacy.snapshotHash, legacy.snapshot)
  );
  assert.equal(legacy.snapshot.schemaVersion, 1);
  assert.equal(legacyReceipt.receipt.schemaVersion, 1);
  assert.equal(Object.hasOwn(legacy.snapshot, 'confirmations'), false);
  assert.equal(Object.hasOwn(legacyReceipt.receipt, 'confirmations'), false);

  const confirmed = await store.saveSnapshot(confirmedFixtureSnapshot({
    serviceSetId: 'service-2026-07-28-confirmed'
  }));
  const confirmedReceipt = await store.saveCommitReceipt(
    receiptRequest(confirmed.snapshotHash, confirmed.snapshot)
  );
  assert.equal(confirmed.snapshot.schemaVersion, 2);
  assert.equal(confirmedReceipt.receipt.schemaVersion, 2);
  assert.equal(
    confirmed.snapshot.family.members.some(member =>
      Object.hasOwn(member, 'localServiceRights')),
    false
  );
  assert.equal(
    confirmedReceipt.receipt.results.some(result =>
      Object.hasOwn(result, 'localServiceRights')),
    false
  );

  const current = await store.saveSnapshot(currentFixtureSnapshot({
    serviceSetId: 'service-2026-07-28-current'
  }));
  const currentReceipt = await store.saveCommitReceipt(
    receiptRequest(current.snapshotHash, current.snapshot)
  );
  assert.equal(
    current.snapshot.schemaVersion,
    SONG_FAMILY_REVIEW_SNAPSHOT_SCHEMA_VERSION
  );
  assert.equal(
    currentReceipt.receipt.schemaVersion,
    SONG_FAMILY_REVIEW_RECEIPT_SCHEMA_VERSION
  );
  assert.deepEqual(
    currentReceipt.receipt.confirmations,
    current.snapshot.confirmations
  );
  assert.equal(
    current.snapshot.confirmations.authorityScope,
    'local-song-library-only'
  );
  assert.equal(
    current.snapshot.confirmations.communityAuthorityGranted,
    false
  );
  assert.deepEqual(
    currentReceipt.receipt.results.map(result =>
      result.localServiceRights),
    current.snapshot.family.members.map(member =>
      member.localServiceRights)
  );
  assert.ok(current.snapshot.family.members.every(member =>
    member.localServiceRights.reviewedAt === current.snapshot.reviewedAt));

  const invalidSnapshots = [];
  const missing = currentFixtureSnapshot();
  delete missing.confirmations;
  invalidSnapshots.push(missing);
  const unconfirmed = currentFixtureSnapshot();
  unconfirmed.confirmations.rightsConfirmed = false;
  invalidSnapshots.push(unconfirmed);
  const community = currentFixtureSnapshot();
  community.confirmations.communityAuthorityGranted = true;
  invalidSnapshots.push(community);
  const wrongScope = currentFixtureSnapshot();
  wrongScope.confirmations.authorityScope = 'community';
  invalidSnapshots.push(wrongScope);
  const extended = currentFixtureSnapshot();
  extended.confirmations.communityVisibility = 'public';
  invalidSnapshots.push(extended);
  const missingRights = currentFixtureSnapshot();
  delete missingRights.family.members[0].localServiceRights;
  invalidSnapshots.push(missingRights);
  const blankEvidence = currentFixtureSnapshot();
  blankEvidence.family.members[0].localServiceRights.evidence = '';
  invalidSnapshots.push(blankEvidence);
  const staleTime = currentFixtureSnapshot();
  staleTime.family.members[0].localServiceRights.reviewedAt =
    '2026-07-28T12:00:01.000Z';
  invalidSnapshots.push(staleTime);
  const communityRights = currentFixtureSnapshot();
  communityRights.family.members[0].localServiceRights.visibility = 'public';
  invalidSnapshots.push(communityRights);

  for (const invalid of invalidSnapshots) {
    await assert.rejects(
      store.saveSnapshot(invalid),
      expectCode('INVALID_REVIEW_SNAPSHOT')
    );
  }

  const receiptPath = path.join(
    rootPath,
    'receipts',
    current.snapshotHash.slice(0, 2),
    current.snapshotHash,
    `${currentReceipt.receiptHash}.json`
  );
  const receiptWithCommunityAuthority = structuredClone(
    currentReceipt.receipt
  );
  receiptWithCommunityAuthority.results[0]
    .localServiceRights.communityVisibility = 'public';
  await fs.writeFile(
    receiptPath,
    canonicalBytes(receiptWithCommunityAuthority)
  );
  const tamperedStatus = await store.readReviewStatus({
    snapshotHash: current.snapshotHash
  });
  assert.equal(tamperedStatus.reviewed, false);
  assert.equal(tamperedStatus.skippedCorruptReceipts, 1);
});

test('snapshot schema rejects unsupported policy and inexact PowerPoint evidence', async t => {
  const { rootPath } = await temporaryRoot(t);
  const store = new LocalSongFamilyReviewStore({ rootPath });
  const invalidSnapshots = [];

  const policy = fixtureSnapshot();
  policy.visibility = 'community';
  invalidSnapshots.push(policy);

  const rights = fixtureSnapshot();
  rights.family.members[0].rights = { ccli: true };
  invalidSnapshots.push(rights);

  const badDate = fixtureSnapshot();
  badDate.serviceSet.serviceDate = '2026-02-31';
  invalidSnapshots.push(badDate);

  const pathSource = fixtureSnapshot();
  pathSource.serviceSet.decks[0].sourceName = '../Russian.pptx';
  invalidSnapshots.push(pathSource);

  const duplicateRole = fixtureSnapshot();
  duplicateRole.serviceSet.decks[0].roleId =
    duplicateRole.serviceSet.decks[1].roleId;
  invalidSnapshots.push(duplicateRole);

  const deckMismatch = fixtureSnapshot();
  deckMismatch.family.members[0].captures[0].deckSha256 = 'd'.repeat(64);
  invalidSnapshots.push(deckMismatch);

  const laneMismatch = fixtureSnapshot();
  laneMismatch.family.members[0].captures[0].slides[0].lane = 'current';
  invalidSnapshots.push(laneMismatch);

  const candidateMismatch = fixtureSnapshot();
  candidateMismatch.family.members[0].captures[0].candidateId =
    'slides-1-2-4';
  invalidSnapshots.push(candidateMismatch);

  const slideHashMismatch = fixtureSnapshot();
  slideHashMismatch.family.members[0].captures[0].slides[0].textSha256 =
    'e'.repeat(64);
  invalidSnapshots.push(slideHashMismatch);

  const captureHashMismatch = fixtureSnapshot();
  captureHashMismatch.family.members[0].captures[0].capturedTextSha256 =
    'e'.repeat(64);
  invalidSnapshots.push(captureHashMismatch);

  const capturedDocumentMismatch = fixtureSnapshot();
  const changedSlide =
    capturedDocumentMismatch.family.members[0].captures[0].slides[0];
  changedSlide.lines = ['Edited only in evidence'];
  changedSlide.textSha256 = sha256(
    Buffer.from(JSON.stringify(changedSlide.lines), 'utf8')
  );
  capturedDocumentMismatch.family.members[0].captures[0].capturedTextSha256 =
    sha256(Buffer.from(JSON.stringify(
      capturedDocumentMismatch.family.members[0]
        .captures[0].slides.map(slide => slide.lines)
    ), 'utf8'));
  invalidSnapshots.push(capturedDocumentMismatch);

  const missingRequiredCapture = fixtureSnapshot();
  missingRequiredCapture.family.members[0].captures = [];
  invalidSnapshots.push(missingRequiredCapture);

  const missingCapturedMemberEvidence = fixtureSnapshot();
  missingCapturedMemberEvidence.family.occurrences[0].evidence.pop();
  invalidSnapshots.push(missingCapturedMemberEvidence);

  const revisionMismatch = fixtureSnapshot();
  revisionMismatch.family.members[0].reviewedRevision = 'e'.repeat(64);
  invalidSnapshots.push(revisionMismatch);

  const textMismatch = fixtureSnapshot();
  textMismatch.family.members[0].finalTextSha256 = 'e'.repeat(64);
  invalidSnapshots.push(textMismatch);

  const relationshipMismatch = fixtureSnapshot();
  relationshipMismatch.family.members[0].translationOf = null;
  invalidSnapshots.push(relationshipMismatch);

  for (const invalid of invalidSnapshots) {
    await assert.rejects(
      store.saveSnapshot(invalid),
      expectCode('INVALID_REVIEW_SNAPSHOT')
    );
  }
  assert.deepEqual(await jsonFiles(rootPath), []);
});

test('ten performed occurrences retain a six-section exact bilingual arrangement', async t => {
  const { rootPath } = await temporaryRoot(t);
  const store = new LocalSongFamilyReviewStore({ rootPath });
  const saved = await store.saveSnapshot(tenOccurrenceSnapshot());

  assert.equal(saved.snapshot.family.occurrences.length, 10);
  assert.deepEqual(
    saved.snapshot.family.occurrences.map(occurrence => occurrence.sectionId),
    ['p1', 'p2', 'p3', 'p4', 'p1', 'p2', 'p3', 'p5', 'p3', 'p6']
  );
  assert.deepEqual(
    saved.snapshot.family.occurrences.map(occurrence => occurrence.action),
    ['new', 'new', 'new', 'new', 'repeat', 'repeat', 'repeat', 'new', 'repeat', 'new']
  );
  assert.ok(saved.snapshot.family.members.every(member =>
    parseSongDocument(member.documentSource, {
      fileName: `${member.songId}.md`
    }).sections.length === 6));

  const request = receiptRequest(saved.snapshotHash, saved.snapshot);
  const committed = await store.saveCommitReceipt(request);
  assert.deepEqual(
    committed.receipt.occurrences.map(occurrence => occurrence.sectionId),
    ['p1', 'p2', 'p3', 'p4', 'p1', 'p2', 'p3', 'p5', 'p3', 'p6']
  );
  assert.ok(committed.receipt.occurrences.every(occurrence =>
    occurrence.evidence.length === 2
    && occurrence.evidence.every(item =>
      /^[a-f0-9]{64}$/u.test(item.textSha256))));
  assert.doesNotMatch(
    canonicalBytes(committed.receipt).toString('utf8'),
    /EN P1|RU P1/u
  );
});

test('repeat decisions reject one-sided text drift and occurrence evidence reuse', async t => {
  const { rootPath } = await temporaryRoot(t);
  const store = new LocalSongFamilyReviewStore({ rootPath });
  const oneSided = tenOccurrenceSnapshot();
  const translation = oneSided.family.members.find(member =>
    member.songId === 'july-family-ru');
  const repeatedSlide = translation.captures[0].slides.find(slide =>
    slide.number === 16);
  repeatedSlide.lines = ['RU P1 changed on one side'];
  repeatedSlide.textSha256 = sha256(
    Buffer.from(JSON.stringify(repeatedSlide.lines), 'utf8')
  );
  translation.captures[0].capturedTextSha256 = sha256(Buffer.from(
    JSON.stringify(translation.captures[0].slides.map(slide => slide.lines)),
    'utf8'
  ));
  await assert.rejects(
    store.saveSnapshot(oneSided),
    expectCode('INVALID_REVIEW_SNAPSHOT')
  );

  const duplicateEvidence = tenOccurrenceSnapshot();
  duplicateEvidence.family.occurrences[1].evidence[0].slideNumber = 12;
  await assert.rejects(
    store.saveSnapshot(duplicateEvidence),
    expectCode('INVALID_REVIEW_SNAPSHOT')
  );
  assert.deepEqual(await jsonFiles(rootPath), []);
});

test('an explicit exclude retains complete paired evidence without entering the document', async t => {
  const { rootPath } = await temporaryRoot(t);
  const store = new LocalSongFamilyReviewStore({ rootPath });
  const snapshot = fixtureSnapshot();
  for (const member of snapshot.family.members) {
    const captureItem = member.captures[0];
    const lines = [`Excluded ${member.songId}`];
    captureItem.candidateId = 'slides-1-2-4';
    captureItem.slides.push({
      number: 4,
      lane: captureItem.slides[0].lane,
      lines,
      textSha256: sha256(Buffer.from(JSON.stringify(lines), 'utf8'))
    });
    captureItem.capturedTextSha256 = sha256(Buffer.from(
      JSON.stringify(captureItem.slides.map(slide => slide.lines)),
      'utf8'
    ));
  }
  snapshot.family.occurrences.push({
    occurrenceId: 'slide-4',
    action: 'exclude',
    sectionId: null,
    repeatOfOccurrenceId: null,
    evidence: snapshot.family.members.map(member => ({
      songId: member.songId,
      captureOrdinal: 1,
      slideNumber: 4
    }))
  });

  const saved = await store.saveSnapshot(snapshot);
  assert.deepEqual(
    saved.snapshot.family.occurrences.at(-1),
    {
      occurrenceId: 'slide-4',
      action: 'exclude',
      sectionId: null,
      repeatOfOccurrenceId: null,
      evidence: [{
        songId: 'captured-family',
        captureOrdinal: 1,
        slideNumber: 4
      }, {
        songId: 'captured-family-ru',
        captureOrdinal: 1,
        slideNumber: 4
      }]
    }
  );
  assert.ok(saved.snapshot.family.members.every(member =>
    parseSongDocument(member.documentSource, {
      fileName: `${member.songId}.md`
    }).sections.length === 2));
  const committed = await store.saveCommitReceipt(
    receiptRequest(saved.snapshotHash, saved.snapshot)
  );
  assert.equal(committed.receipt.occurrences.at(-1).action, 'exclude');
  assert.equal(committed.receipt.occurrences.at(-1).evidence.length, 2);
});

test('one exact receipt binds resulting member and family revisions', async t => {
  const { rootPath } = await temporaryRoot(t);
  const store = new LocalSongFamilyReviewStore({ rootPath });
  const saved = await store.saveSnapshot(fixtureSnapshot());
  const request = receiptRequest(saved.snapshotHash, saved.snapshot);

  const committed = await store.saveCommitReceipt(request);
  const repeated = await store.saveCommitReceipt(reverseObjectKeys(request));
  assert.equal(committed.unchanged, false);
  assert.equal(repeated.unchanged, true);
  assert.equal(repeated.receiptHash, committed.receiptHash);
  assert.deepEqual(repeated.receipt, committed.receipt);
  assert.equal(committed.receipt.kind, SONG_FAMILY_REVIEW_RECEIPT_KIND);
  assert.equal(committed.receipt.familyRevision, request.familyRevision);
  assert.deepEqual(
    committed.receipt.results.map(result => result.resultingRevision),
    saved.snapshot.family.members.map(member => member.reviewedRevision)
  );
  assert.ok(committed.receipt.results.every(result =>
    result.captures.every(item =>
      item.slides.every(slide =>
        !Object.hasOwn(slide, 'lines')))));

  const status = await store.readReviewStatus({
    snapshotHash: saved.snapshotHash
  });
  assert.equal(status.reviewed, true);
  assert.equal(status.receipts.length, 1);
  assert.equal(status.receipts[0].receiptHash, committed.receiptHash);
  assert.equal(status.skippedCorruptReceipts, 0);

  const receiptPath = path.join(
    rootPath,
    'receipts',
    saved.snapshotHash.slice(0, 2),
    saved.snapshotHash,
    `${committed.receiptHash}.json`
  );
  const bytes = await fs.readFile(receiptPath);
  assert.ok(bytes.equals(canonicalBytes(committed.receipt)));
  assert.equal(sha256(bytes), committed.receiptHash);
  assert.doesNotMatch(bytes.toString('utf8'), /Root line|Первая строка/u);
  assert.doesNotMatch(
    bytes.toString('utf8'),
    /"community"|"rights"|"visibility"|"documentSource"/iu
  );
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(receiptPath)).mode & 0o077, 0);
  }

  await assert.rejects(
    store.saveCommitReceipt({
      ...request,
      committedAt: '2026-07-28T13:00:01.000Z'
    }),
    expectCode('REVIEW_RECEIPT_CONFLICT')
  );
});

test('review store commits through the real family coordinator and retries unchanged', async t => {
  const { parent } = await temporaryRoot(t);
  const libraryRoot = path.join(parent, 'song-library');
  const reviewRoot = path.join(parent, 'family-reviews');
  const recoveryAuthority = Symbol('test-family-recovery');
  const library = new LocalSongLibrary({
    rootPath: libraryRoot,
    familyRecoveryAuthority: recoveryAuthority
  });
  const store = new LocalSongFamilyReviewStore({ rootPath: reviewRoot });
  const saved = await store.saveSnapshot(fixtureSnapshot());
  const coordinator = new LocalSongFamilyCommitCoordinator({
    rootPath: libraryRoot,
    songLibrary: library,
    reviewStore: store,
    recoveryAuthority,
    clock: () => new Date('2026-07-28T13:00:00.000Z')
  });

  const committed = await coordinator.commit({
    snapshotHash: saved.snapshotHash
  });
  assert.equal(committed.familyId, saved.snapshot.family.rootSongId);
  assert.match(committed.familyRevision, /^[a-f0-9]{64}$/u);
  for (const member of saved.snapshot.family.members) {
    const current = await library.read(member.songId);
    assert.equal(current.revision, member.reviewedRevision);
    assert.equal(current.song.translationOf, member.translationOf);
  }

  const status = await store.readReviewStatus({
    snapshotHash: saved.snapshotHash
  });
  assert.equal(status.reviewed, true);
  assert.equal(status.receipts.length, 1);
  assert.equal(status.receipts[0].familyRevision, committed.familyRevision);
  const byFamily = await store.findByFamilyRevision({
    rootSongId: committed.familyId,
    familyRevision: committed.familyRevision
  });
  assert.equal(byFamily.snapshot.snapshotHash, saved.snapshotHash);
  for (const member of saved.snapshot.family.members) {
    const byMember = await store.findByMemberRevision({
      songId: member.songId,
      revision: member.reviewedRevision
    });
    assert.equal(byMember.receipt.receiptHash, status.receipts[0].receiptHash);
  }
  assert.equal(
    (await new DurableFamilyJournal({
      rootPath: libraryRoot
    }).read()).clear,
    true
  );

  const retried = await coordinator.commit({
    snapshotHash: saved.snapshotHash
  });
  assert.equal(retried.unchanged, true);
  assert.equal(retried.familyRevision, committed.familyRevision);
  assert.equal(
    retried.receipt.receiptHash,
    status.receipts[0].receiptHash
  );
  assert.equal(
    (await store.readReviewStatus({ snapshotHash: saved.snapshotHash }))
      .receipts.length,
    1
  );
});

test('the coordinator reserves receipt capacity before publishing its journal or pointers', async t => {
  const { parent } = await temporaryRoot(t);
  const libraryRoot = path.join(parent, 'song-library');
  const reviewRoot = path.join(parent, 'family-reviews');
  const recoveryAuthority = Symbol('test-family-recovery');
  const library = new LocalSongLibrary({
    rootPath: libraryRoot,
    familyRecoveryAuthority: recoveryAuthority
  });
  const store = new LocalSongFamilyReviewStore({
    rootPath: reviewRoot,
    maximumReceipts: 1
  });
  const reserved = await store.saveSnapshot(fixtureSnapshot());
  await store.prepareCommitReceiptStorage({
    snapshotHash: reserved.snapshotHash
  });
  const candidate = await store.saveSnapshot(fixtureSnapshot({
    reviewedAt: '2026-07-28T12:00:01.000Z'
  }));
  const coordinator = new LocalSongFamilyCommitCoordinator({
    rootPath: libraryRoot,
    songLibrary: library,
    reviewStore: store,
    recoveryAuthority,
    clock: () => new Date('2026-07-28T13:00:00.000Z')
  });

  await assert.rejects(
    coordinator.commit({ snapshotHash: candidate.snapshotHash }),
    expectCode('RECEIPT_CAPACITY_REACHED')
  );
  for (const member of candidate.snapshot.family.members) {
    assert.equal(
      await library.withCurrentSnapshot(
        session => session.readCurrent(member.songId)
      ),
      null
    );
  }
  assert.equal(
    (await new DurableFamilyJournal({ rootPath: libraryRoot }).read()).clear,
    true
  );
  assert.deepEqual(
    await store.readReviewStatus({ snapshotHash: candidate.snapshotHash }),
    {
      snapshotHash: candidate.snapshotHash,
      reviewed: false,
      receipts: [],
      skippedCorruptReceipts: 0
    }
  );
  const candidateReceiptDirectory = path.join(
    reviewRoot,
    'receipts',
    candidate.snapshotHash.slice(0, 2),
    candidate.snapshotHash
  );
  assert.equal(
    (await fs.readdir(candidateReceiptDirectory))
      .includes('.receipt-capacity-reservation.json'),
    false
  );
});

test('the coordinator cannot restage a family after its committed receipt is lost', async t => {
  const { parent } = await temporaryRoot(t);
  const libraryRoot = path.join(parent, 'song-library');
  const reviewRoot = path.join(parent, 'family-reviews');
  const recoveryAuthority = Symbol('test-family-recovery');
  const library = new LocalSongLibrary({
    rootPath: libraryRoot,
    familyRecoveryAuthority: recoveryAuthority
  });
  const store = new LocalSongFamilyReviewStore({ rootPath: reviewRoot });
  const saved = await store.saveSnapshot(fixtureSnapshot());
  const coordinator = new LocalSongFamilyCommitCoordinator({
    rootPath: libraryRoot,
    songLibrary: library,
    reviewStore: store,
    recoveryAuthority,
    clock: () => new Date('2026-07-28T13:00:00.000Z')
  });
  const committed = await coordinator.commit({
    snapshotHash: saved.snapshotHash
  });
  const status = await store.readReviewStatus({
    snapshotHash: saved.snapshotHash
  });
  const revisionsBefore = new Map();
  for (const member of saved.snapshot.family.members) {
    revisionsBefore.set(member.songId, (await library.read(member.songId)).revision);
  }
  const receiptPath = path.join(
    reviewRoot,
    'receipts',
    saved.snapshotHash.slice(0, 2),
    saved.snapshotHash,
    `${status.receipts[0].receiptHash}.json`
  );

  await fs.unlink(receiptPath);
  await assert.rejects(
    coordinator.commit({ snapshotHash: saved.snapshotHash }),
    error => {
      assert.equal(error.code, 'FAMILY_COMMIT_EVIDENCE_CORRUPT');
      return true;
    }
  );
  for (const member of saved.snapshot.family.members) {
    assert.equal(
      (await library.read(member.songId)).revision,
      revisionsBefore.get(member.songId)
    );
  }
  assert.equal(
    (await new DurableFamilyJournal({
      rootPath: libraryRoot
    }).read()).clear,
    true
  );
  assert.equal(committed.familyRevision, status.receipts[0].familyRevision);
});

test('recovery finishes a receipt that was durable just before its witness write failed', async t => {
  const { parent } = await temporaryRoot(t);
  const libraryRoot = path.join(parent, 'song-library');
  const reviewRoot = path.join(parent, 'family-reviews');
  const recoveryAuthority = Symbol('test-family-recovery');
  const library = new LocalSongLibrary({
    rootPath: libraryRoot,
    familyRecoveryAuthority: recoveryAuthority
  });
  const store = new LocalSongFamilyReviewStore({ rootPath: reviewRoot });
  const saved = await store.saveSnapshot(fixtureSnapshot());
  const coordinator = new LocalSongFamilyCommitCoordinator({
    rootPath: libraryRoot,
    songLibrary: library,
    reviewStore: store,
    recoveryAuthority,
    clock: () => new Date('2026-07-28T13:00:00.000Z')
  });
  const storeImmutable = store._storeImmutable.bind(store);
  let failWitnessOnce = true;
  store._storeImmutable = async (...args) => {
    if (failWitnessOnce && args[5] === 'song-family commit witness') {
      failWitnessOnce = false;
      throw new Error('injected witness publication failure');
    }
    return storeImmutable(...args);
  };

  await assert.rejects(
    coordinator.commit({ snapshotHash: saved.snapshotHash }),
    error => {
      assert.equal(error.code, 'STORE_UNAVAILABLE');
      return true;
    }
  );
  assert.equal(
    (await new DurableFamilyJournal({ rootPath: libraryRoot }).read()).clear,
    false
  );
  const interruptedStatus = await store.readReviewStatus({
    snapshotHash: saved.snapshotHash
  });
  assert.equal(interruptedStatus.reviewed, false);
  assert.equal(interruptedStatus.skippedCorruptReceipts, 1);

  store._storeImmutable = storeImmutable;
  const recovered = await coordinator.recover();
  assert.equal(recovered.recovered, true);
  assert.equal(
    (await store.readReviewStatus({ snapshotHash: saved.snapshotHash }))
      .reviewed,
    true
  );
  assert.equal(
    (await new DurableFamilyJournal({ rootPath: libraryRoot }).read()).clear,
    true
  );
});

test('a reviewed commit retains an untouched uncaptured translation in the complete family', async t => {
  const { parent } = await temporaryRoot(t);
  const libraryRoot = path.join(parent, 'song-library');
  const reviewRoot = path.join(parent, 'family-reviews');
  const recoveryAuthority = Symbol('test-family-recovery');
  const library = new LocalSongLibrary({
    rootPath: libraryRoot,
    familyRecoveryAuthority: recoveryAuthority
  });
  const store = new LocalSongFamilyReviewStore({ rootPath: reviewRoot });
  const priorRoot = canonicalSong({
    id: 'captured-family',
    title: 'Captured Family',
    language: 'en',
    slideLines: [['Prior root one'], ['Prior root two']]
  });
  const priorTranslation = canonicalSong({
    id: 'captured-family-ru',
    title: 'Семья песни',
    language: 'ru',
    translationOf: 'captured-family',
    slideLines: [['Предыдущая строка один'], ['Предыдущая строка два']]
  });
  const untouchedTranslation = canonicalSong({
    id: 'captured-family-es',
    title: 'Familia de canción',
    language: 'es',
    translationOf: 'captured-family',
    slideLines: [['Línea conservada uno'], ['Línea conservada dos']]
  });
  const currentRoot = await library.saveSource(priorRoot.documentSource, {
    expectedRevision: null
  });
  const currentRussian = await library.saveSource(
    priorTranslation.documentSource,
    { expectedRevision: null }
  );
  const currentSpanish = await library.saveSource(
    untouchedTranslation.documentSource,
    { expectedRevision: null }
  );

  const snapshot = fixtureSnapshot();
  const currentById = new Map([
    [currentRoot.song.id, currentRoot],
    [currentRussian.song.id, currentRussian]
  ]);
  for (const member of snapshot.family.members) {
    member.action = 'update';
    member.expectedRevision = currentById.get(member.songId).revision;
  }
  snapshot.family.members.push({
    songId: currentSpanish.song.id,
    familyRole: 'translation',
    translationOf: 'captured-family',
    action: 'reuse',
    expectedRevision: currentSpanish.revision,
    reviewedRevision: currentSpanish.revision,
    finalTextSha256: untouchedTranslation.textSha256,
    documentSource: currentSpanish.source,
    captures: []
  });

  const saved = await store.saveSnapshot(snapshot);
  assert.equal(saved.snapshot.family.members.length, 3);
  assert.deepEqual(
    saved.snapshot.family.occurrences.map(occurrence =>
      occurrence.evidence.map(item => item.songId)),
    [
      ['captured-family', 'captured-family-ru'],
      ['captured-family', 'captured-family-ru']
    ]
  );
  const coordinator = new LocalSongFamilyCommitCoordinator({
    rootPath: libraryRoot,
    songLibrary: library,
    reviewStore: store,
    recoveryAuthority,
    clock: () => new Date('2026-07-28T13:00:00.000Z')
  });
  const committed = await coordinator.commit({
    snapshotHash: saved.snapshotHash
  });

  assert.equal(
    (await library.read(currentSpanish.song.id)).revision,
    currentSpanish.revision
  );
  const status = await store.readReviewStatus({
    snapshotHash: saved.snapshotHash
  });
  assert.equal(status.receipts.length, 1);
  const receipt = status.receipts[0];
  assert.equal(receipt.familyRevision, committed.familyRevision);
  assert.deepEqual(
    receipt.results.find(result =>
      result.songId === currentSpanish.song.id).captures,
    []
  );
  assert.ok(receipt.occurrences.every(occurrence =>
    occurrence.evidence.length === 2
    && occurrence.evidence.every(item =>
      item.songId !== currentSpanish.song.id)));
});

test('receipt requests fail closed on revision, family, coverage, or policy drift', async t => {
  const { rootPath } = await temporaryRoot(t);
  const store = new LocalSongFamilyReviewStore({ rootPath });
  const saved = await store.saveSnapshot(fixtureSnapshot());
  const valid = receiptRequest(saved.snapshotHash, saved.snapshot);
  const invalidRequests = [];

  invalidRequests.push({
    ...valid,
    familyRevision: 'f'.repeat(64)
  });
  invalidRequests.push({
    ...valid,
    results: valid.results.slice(0, 1)
  });
  invalidRequests.push({
    ...valid,
    results: valid.results.map((result, index) => index === 0
      ? { ...result, resultingRevision: 'f'.repeat(64) }
      : result)
  });
  invalidRequests.push({
    ...valid,
    results: valid.results.map((result, index) => index === 0
      ? { ...result, previousRevision: 'f'.repeat(64) }
      : result)
  });
  invalidRequests.push({
    ...valid,
    visibility: 'community'
  });
  invalidRequests.push({
    ...valid,
    committedAt: '2026-07-28T11:59:59.999Z'
  });

  for (const request of invalidRequests) {
    await assert.rejects(
      store.saveCommitReceipt(request),
      expectCode('INVALID_REVIEW_RECEIPT')
    );
  }
  const status = await store.readReviewStatus({
    snapshotHash: saved.snapshotHash
  });
  assert.equal(status.reviewed, false);
  assert.equal(status.receipts.length, 0);
});

test('snapshot and receipt capacities are bounded without breaking exact retries', async t => {
  const snapshotsRoot = await temporaryRoot(t);
  const snapshotsStore = new LocalSongFamilyReviewStore({
    rootPath: snapshotsRoot.rootPath,
    maximumSnapshots: 1
  });
  const first = await snapshotsStore.saveSnapshot(fixtureSnapshot());
  assert.equal(
    (await snapshotsStore.saveSnapshot(fixtureSnapshot())).unchanged,
    true
  );
  await assert.rejects(
    snapshotsStore.saveSnapshot(fixtureSnapshot({
      reviewedAt: '2026-07-28T12:00:01.000Z'
    })),
    expectCode('SNAPSHOT_CAPACITY_REACHED')
  );

  const receiptsRoot = await temporaryRoot(t);
  const receiptsStore = new LocalSongFamilyReviewStore({
    rootPath: receiptsRoot.rootPath,
    maximumReceipts: 1
  });
  const receiptFirst = await receiptsStore.saveSnapshot(fixtureSnapshot());
  const receiptSecond = await receiptsStore.saveSnapshot(fixtureSnapshot({
    reviewedAt: '2026-07-28T12:00:01.000Z'
  }));
  const firstRequest = receiptRequest(
    receiptFirst.snapshotHash,
    receiptFirst.snapshot
  );
  await receiptsStore.saveCommitReceipt(firstRequest);
  assert.equal(
    (await receiptsStore.saveCommitReceipt(firstRequest)).unchanged,
    true
  );
  await assert.rejects(
    receiptsStore.saveCommitReceipt(
      receiptRequest(receiptSecond.snapshotHash, receiptSecond.snapshot)
    ),
    expectCode('RECEIPT_CAPACITY_REACHED')
  );

  assert.match(first.snapshotHash, /^[a-f0-9]{64}$/u);
});

test('receipt capacity reservations are durable and idempotent for one exact snapshot', async t => {
  const { rootPath } = await temporaryRoot(t);
  const store = new LocalSongFamilyReviewStore({
    rootPath,
    maximumReceipts: 1
  });
  const first = await store.saveSnapshot(fixtureSnapshot());
  const second = await store.saveSnapshot(fixtureSnapshot({
    reviewedAt: '2026-07-28T12:00:01.000Z'
  }));

  const expectedPreparation = {
    snapshotHash: first.snapshotHash,
    prepared: true
  };
  assert.deepEqual(
    await store.prepareCommitReceiptStorage({
      snapshotHash: first.snapshotHash
    }),
    expectedPreparation
  );
  assert.deepEqual(
    await store.prepareCommitReceiptStorage({
      snapshotHash: first.snapshotHash
    }),
    expectedPreparation
  );
  const reservationPath = path.join(
    rootPath,
    'receipts',
    first.snapshotHash.slice(0, 2),
    first.snapshotHash,
    '.receipt-capacity-reservation.json'
  );
  assert.deepEqual(JSON.parse(await fs.readFile(reservationPath, 'utf8')), {
    kind: 'syncshow-song-family-receipt-capacity-reservation',
    schemaVersion: 1,
    snapshotHash: first.snapshotHash
  });
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(reservationPath)).mode & 0o077, 0);
  }

  const reopened = new LocalSongFamilyReviewStore({
    rootPath,
    maximumReceipts: 1
  });
  assert.deepEqual(
    await reopened.prepareCommitReceiptStorage({
      snapshotHash: first.snapshotHash
    }),
    expectedPreparation
  );
  await assert.rejects(
    reopened.prepareCommitReceiptStorage({
      snapshotHash: second.snapshotHash
    }),
    expectCode('RECEIPT_CAPACITY_REACHED')
  );

  const committed = await reopened.saveCommitReceipt(
    receiptRequest(first.snapshotHash, first.snapshot)
  );
  assert.equal(committed.unchanged, false);
  assert.deepEqual(
    await reopened.prepareCommitReceiptStorage({
      snapshotHash: first.snapshotHash
    }),
    expectedPreparation
  );
  await assert.rejects(
    reopened.prepareCommitReceiptStorage({
      snapshotHash: second.snapshotHash
    }),
    expectCode('RECEIPT_CAPACITY_REACHED')
  );
});

test('tampered snapshots and receipts are never accepted as review evidence', async t => {
  const snapshotCase = await temporaryRoot(t);
  const snapshotStore = new LocalSongFamilyReviewStore({
    rootPath: snapshotCase.rootPath
  });
  const snapshotSaved = await snapshotStore.saveSnapshot(fixtureSnapshot());
  const snapshotPath = path.join(
    snapshotCase.rootPath,
    'snapshots',
    snapshotSaved.snapshotHash.slice(0, 2),
    `${snapshotSaved.snapshotHash}.json`
  );
  await fs.appendFile(snapshotPath, Buffer.from(' ', 'utf8'));
  await assert.rejects(
    snapshotStore.readSnapshot(snapshotSaved.snapshotHash),
    expectCode('SNAPSHOT_CORRUPT')
  );

  const receiptCase = await temporaryRoot(t);
  const receiptStore = new LocalSongFamilyReviewStore({
    rootPath: receiptCase.rootPath
  });
  const saved = await receiptStore.saveSnapshot(fixtureSnapshot());
  const request = receiptRequest(saved.snapshotHash, saved.snapshot);
  const committed = await receiptStore.saveCommitReceipt(request);
  const receiptPath = path.join(
    receiptCase.rootPath,
    'receipts',
    saved.snapshotHash.slice(0, 2),
    saved.snapshotHash,
    `${committed.receiptHash}.json`
  );
  await fs.appendFile(receiptPath, Buffer.from(' ', 'utf8'));
  const status = await receiptStore.readReviewStatus({
    snapshotHash: saved.snapshotHash
  });
  assert.equal(status.reviewed, false);
  assert.equal(status.skippedCorruptReceipts, 1);
  await assert.rejects(
    receiptStore.findByFamilyRevision({
      rootSongId: saved.snapshot.family.rootSongId,
      familyRevision: request.familyRevision
    }),
    expectCode('REVIEW_EVIDENCE_CORRUPT')
  );
});

test('a missing committed receipt is durable corruption, not an unreviewed snapshot', async t => {
  const { rootPath } = await temporaryRoot(t);
  const store = new LocalSongFamilyReviewStore({ rootPath });
  const saved = await store.saveSnapshot(fixtureSnapshot());
  const request = receiptRequest(saved.snapshotHash, saved.snapshot);
  const committed = await store.saveCommitReceipt(request);
  const receiptDirectory = path.join(
    rootPath,
    'receipts',
    saved.snapshotHash.slice(0, 2),
    saved.snapshotHash
  );
  const receiptPath = path.join(
    receiptDirectory,
    `${committed.receiptHash}.json`
  );
  const witnessPath = path.join(receiptDirectory, '.committed.json');
  const witnessBefore = await fs.readFile(witnessPath);

  await fs.unlink(receiptPath);
  const status = await store.readReviewStatus({
    snapshotHash: saved.snapshotHash
  });
  assert.equal(status.reviewed, false);
  assert.deepEqual(status.receipts, []);
  assert.equal(status.skippedCorruptReceipts, 1);
  await assert.rejects(
    store.saveCommitReceipt(request),
    expectCode('REVIEW_RECEIPT_CORRUPT')
  );
  assert.ok((await fs.readFile(witnessPath)).equals(witnessBefore));
  assert.deepEqual(
    (await fs.readdir(receiptDirectory))
      .filter(name => /^[a-f0-9]{64}\.json$/u.test(name)),
    []
  );
  await assert.rejects(
    store.findByFamilyRevision({
      rootSongId: saved.snapshot.family.rootSongId,
      familyRevision: request.familyRevision
    }),
    expectCode('REVIEW_EVIDENCE_CORRUPT')
  );
});

test('a tampered commit witness prevents receipt reuse', async t => {
  const { rootPath } = await temporaryRoot(t);
  const store = new LocalSongFamilyReviewStore({ rootPath });
  const saved = await store.saveSnapshot(fixtureSnapshot());
  const request = receiptRequest(saved.snapshotHash, saved.snapshot);
  await store.saveCommitReceipt(request);
  const witnessPath = path.join(
    rootPath,
    'receipts',
    saved.snapshotHash.slice(0, 2),
    saved.snapshotHash,
    '.committed.json'
  );

  await fs.appendFile(witnessPath, Buffer.from(' ', 'utf8'));
  const status = await store.readReviewStatus({
    snapshotHash: saved.snapshotHash
  });
  assert.equal(status.reviewed, false);
  assert.equal(status.skippedCorruptReceipts, 1);
  await assert.rejects(
    store.saveCommitReceipt(request),
    expectCode('REVIEW_RECEIPT_CORRUPT')
  );
});

test('snapshot and receipt symlinks are refused even when their targets are valid', async t => {
  if (process.platform === 'win32') t.skip('Symlink safety is POSIX-specific.');
  const snapshotCase = await temporaryRoot(t);
  const snapshotStore = new LocalSongFamilyReviewStore({
    rootPath: snapshotCase.rootPath
  });
  const snapshotSaved = await snapshotStore.saveSnapshot(fixtureSnapshot());
  const snapshotPath = path.join(
    snapshotCase.rootPath,
    'snapshots',
    snapshotSaved.snapshotHash.slice(0, 2),
    `${snapshotSaved.snapshotHash}.json`
  );
  const outsideSnapshot = path.join(snapshotCase.parent, 'outside-snapshot.json');
  await fs.copyFile(snapshotPath, outsideSnapshot);
  await fs.unlink(snapshotPath);
  await fs.symlink(outsideSnapshot, snapshotPath);
  await assert.rejects(
    snapshotStore.readSnapshot(snapshotSaved.snapshotHash),
    expectCode('SNAPSHOT_CORRUPT')
  );

  const receiptCase = await temporaryRoot(t);
  const receiptStore = new LocalSongFamilyReviewStore({
    rootPath: receiptCase.rootPath
  });
  const saved = await receiptStore.saveSnapshot(fixtureSnapshot());
  const request = receiptRequest(saved.snapshotHash, saved.snapshot);
  const committed = await receiptStore.saveCommitReceipt(request);
  const receiptPath = path.join(
    receiptCase.rootPath,
    'receipts',
    saved.snapshotHash.slice(0, 2),
    saved.snapshotHash,
    `${committed.receiptHash}.json`
  );
  const outsideReceipt = path.join(receiptCase.parent, 'outside-receipt.json');
  await fs.copyFile(receiptPath, outsideReceipt);
  await fs.unlink(receiptPath);
  await fs.symlink(outsideReceipt, receiptPath);
  const status = await receiptStore.readReviewStatus({
    snapshotHash: saved.snapshotHash
  });
  assert.equal(status.reviewed, false);
  assert.equal(status.skippedCorruptReceipts, 1);
  assert.ok((await fs.readFile(outsideReceipt)).equals(
    canonicalBytes(committed.receipt)
  ));
});

test('exact member and family indexes reconcile from durable receipts', async t => {
  const { rootPath } = await temporaryRoot(t);
  const store = new LocalSongFamilyReviewStore({ rootPath });
  const saved = await store.saveSnapshot(fixtureSnapshot());
  const request = receiptRequest(saved.snapshotHash, saved.snapshot);
  const committed = await store.saveCommitReceipt(request);
  await fs.rm(path.join(rootPath, 'indexes'), {
    recursive: true,
    force: true
  });

  for (const member of saved.snapshot.family.members) {
    const found = await store.findByMemberRevision({
      songId: member.songId,
      revision: member.reviewedRevision
    });
    assert.equal(found.snapshot.snapshotHash, saved.snapshotHash);
    assert.equal(found.receipt.receiptHash, committed.receiptHash);
    assert.equal(found.reviewStatus.reviewed, true);
  }
  const family = await store.findByFamilyRevision({
    rootSongId: saved.snapshot.family.rootSongId,
    familyRevision: request.familyRevision
  });
  assert.equal(family.snapshot.snapshotHash, saved.snapshotHash);
  assert.equal(family.receipt.receiptHash, committed.receiptHash);

  assert.equal(await store.findByMemberRevision({
    songId: saved.snapshot.family.rootSongId,
    revision: 'f'.repeat(64)
  }), null);
  assert.equal(await store.findByFamilyRevision({
    rootSongId: saved.snapshot.family.rootSongId,
    familyRevision: 'f'.repeat(64)
  }), null);
});

test('exact member lookup can select an older matching ServiceSet review', async t => {
  const { rootPath } = await temporaryRoot(t);
  const store = new LocalSongFamilyReviewStore({ rootPath });
  const olderSnapshot = fixtureSnapshot({
    serviceSetId: 'service-2026-07-28-older'
  });
  olderSnapshot.serviceSet.fingerprint = '1'.repeat(64);
  const newerSnapshot = fixtureSnapshot({
    serviceSetId: 'service-2026-07-28-newer'
  });
  newerSnapshot.serviceSet.fingerprint = '2'.repeat(64);
  const older = await store.saveSnapshot(olderSnapshot);
  const newer = await store.saveSnapshot(newerSnapshot);
  const olderReceipt = await store.saveCommitReceipt(
    receiptRequest(older.snapshotHash, older.snapshot, {
      committedAt: '2026-07-28T13:00:00.000Z'
    })
  );
  const newerReceipt = await store.saveCommitReceipt(
    receiptRequest(newer.snapshotHash, newer.snapshot, {
      committedAt: '2026-07-28T14:00:00.000Z'
    })
  );
  const member = older.snapshot.family.members.find(candidate =>
    candidate.songId === older.snapshot.family.rootSongId);

  const newestAcrossServices = await store.findByMemberRevision({
    songId: member.songId,
    revision: member.reviewedRevision
  });
  assert.equal(newestAcrossServices.snapshot.snapshotHash, newer.snapshotHash);
  assert.equal(
    newestAcrossServices.receipt.receiptHash,
    newerReceipt.receiptHash
  );

  const exactOlderService = await store.findByMemberRevisionForServiceSet({
    songId: member.songId,
    revision: member.reviewedRevision,
    binding: serviceSetBinding(older.snapshot)
  });
  assert.equal(exactOlderService.snapshot.snapshotHash, older.snapshotHash);
  assert.equal(exactOlderService.receipt.receiptHash, olderReceipt.receiptHash);
  assert.deepEqual(
    serviceSetBinding(exactOlderService.snapshot.snapshot),
    serviceSetBinding(older.snapshot)
  );
  assert.equal(exactOlderService.reviewStatus.reviewed, true);
  assert.equal(exactOlderService.reviewStatus.skippedCorruptReceipts, 0);

  assert.equal(await store.findByMemberRevisionForServiceSet({
    songId: member.songId,
    revision: member.reviewedRevision,
    binding: {
      ...serviceSetBinding(older.snapshot),
      profileId: 'another-profile'
    }
  }), null);
});

test('ServiceSet-scoped member lookup rejects malformed bindings and corrupt evidence', async t => {
  const { rootPath } = await temporaryRoot(t);
  const store = new LocalSongFamilyReviewStore({ rootPath });
  const saved = await store.saveSnapshot(fixtureSnapshot());
  const committed = await store.saveCommitReceipt(
    receiptRequest(saved.snapshotHash, saved.snapshot)
  );
  const member = saved.snapshot.family.members.find(candidate =>
    candidate.songId === saved.snapshot.family.rootSongId);
  const request = {
    songId: member.songId,
    revision: member.reviewedRevision,
    binding: serviceSetBinding(saved.snapshot)
  };

  await assert.rejects(
    store.findByMemberRevisionForServiceSet({
      ...request,
      binding: {
        id: request.binding.id,
        fingerprint: request.binding.fingerprint,
        serviceDate: request.binding.serviceDate
      }
    }),
    expectCode('INVALID_REVIEW_LOOKUP')
  );
  await assert.rejects(
    store.findByMemberRevisionForServiceSet({
      ...request,
      binding: {
        ...request.binding,
        serviceDate: '2026-02-31'
      }
    }),
    expectCode('INVALID_REVIEW_LOOKUP')
  );
  await assert.rejects(
    store.findByMemberRevisionForServiceSet({
      ...request,
      binding: {
        ...request.binding,
        extractor: { id: 'unsupported' }
      }
    }),
    expectCode('INVALID_REVIEW_LOOKUP')
  );

  const receiptPath = path.join(
    rootPath,
    'receipts',
    saved.snapshotHash.slice(0, 2),
    saved.snapshotHash,
    `${committed.receiptHash}.json`
  );
  await fs.appendFile(receiptPath, Buffer.from(' ', 'utf8'));
  await assert.rejects(
    store.findByMemberRevisionForServiceSet(request),
    expectCode('REVIEW_EVIDENCE_CORRUPT')
  );
});

test('receipt remains authoritative when rebuildable index publication fails', async t => {
  const { rootPath } = await temporaryRoot(t);
  const store = new LocalSongFamilyReviewStore({ rootPath });
  const saved = await store.saveSnapshot(fixtureSnapshot());
  const request = receiptRequest(saved.snapshotHash, saved.snapshot);
  const publishIndexes = store._ensureIndexesForReceipt.bind(store);
  store._ensureIndexesForReceipt = async () => {
    throw new Error('injected index publication failure');
  };

  await assert.rejects(
    store.saveCommitReceipt(request),
    expectCode('STORE_UNAVAILABLE')
  );
  const statusAfterFailure = await store.readReviewStatus({
    snapshotHash: saved.snapshotHash
  });
  assert.equal(statusAfterFailure.reviewed, true);
  assert.equal(statusAfterFailure.receipts.length, 1);

  store._ensureIndexesForReceipt = publishIndexes;
  const retried = await store.saveCommitReceipt(request);
  assert.equal(retried.unchanged, true);
  const found = await store.findByFamilyRevision({
    rootSongId: saved.snapshot.family.rootSongId,
    familyRevision: request.familyRevision
  });
  assert.equal(found.receipt.receiptHash, retried.receiptHash);
});

test('receipt storage is durably provisioned before a commit can publish evidence', async t => {
  const { rootPath } = await temporaryRoot(t);
  const store = new LocalSongFamilyReviewStore({ rootPath });
  const saved = await store.saveSnapshot(fixtureSnapshot());
  const receiptDirectory = path.join(
    rootPath,
    'receipts',
    saved.snapshotHash.slice(0, 2),
    saved.snapshotHash
  );
  const markerPath = path.join(
    receiptDirectory,
    '.receipt-storage.json'
  );
  const marker = JSON.parse(await fs.readFile(markerPath, 'utf8'));
  assert.deepEqual(marker, {
    kind: 'syncshow-song-family-receipt-storage',
    schemaVersion: 1,
    snapshotHash: saved.snapshotHash
  });

  await fs.unlink(markerPath);
  await assert.rejects(
    store.saveCommitReceipt(
      receiptRequest(saved.snapshotHash, saved.snapshot)
    ),
    expectCode('RECEIPT_STORAGE_UNAVAILABLE')
  );
  assert.deepEqual(
    (await fs.readdir(receiptDirectory))
      .filter(name => /^[a-f0-9]{64}\.json$/u.test(name)),
    []
  );

  assert.deepEqual(
    await store.prepareCommitReceiptStorage({
      snapshotHash: saved.snapshotHash
    }),
    {
      snapshotHash: saved.snapshotHash,
      prepared: true
    }
  );
  const committed = await store.saveCommitReceipt(
    receiptRequest(saved.snapshotHash, saved.snapshot)
  );
  assert.match(committed.receiptHash, /^[a-f0-9]{64}$/u);
});

test('write recovery reclaims only a verified dead owner and preserves an active lock', async t => {
  if (process.platform === 'win32') {
    t.skip('PID liveness and owner-only lock behavior are POSIX-specific.');
  }
  const { rootPath } = await temporaryRoot(t);
  const store = await new LocalSongFamilyReviewStore({ rootPath }).initialize();
  const lockPath = path.join(rootPath, '.song-family-review-write-lock');
  await fs.mkdir(lockPath, { mode: 0o700 });
  await fs.writeFile(
    path.join(lockPath, 'owner.json'),
    `${JSON.stringify({
      token: 'dead-owner',
      pid: 99_999_999,
      createdAt: Date.now()
    })}\n`,
    { encoding: 'utf8', mode: 0o600 }
  );
  const saved = await store.saveSnapshot(fixtureSnapshot());
  assert.match(saved.snapshotHash, /^[a-f0-9]{64}$/u);

  await fs.mkdir(lockPath, { mode: 0o700 });
  await fs.writeFile(
    path.join(lockPath, 'owner.json'),
    `${JSON.stringify({
      token: 'active-owner',
      pid: process.pid,
      createdAt: Date.now()
    })}\n`,
    { encoding: 'utf8', mode: 0o600 }
  );
  await assert.rejects(
    store.saveSnapshot(fixtureSnapshot({
      reviewedAt: '2026-07-28T12:00:01.000Z'
    })),
    expectCode('WRITE_LOCKED')
  );
});
