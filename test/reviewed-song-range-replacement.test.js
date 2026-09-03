'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  SONG_FAMILY_REVIEW_CONFIRMATION_AUTHORITY_SCOPE,
  SONG_FAMILY_REVIEW_RECEIPT_SCHEMA_VERSION,
  SONG_FAMILY_REVIEW_SNAPSHOT_SCHEMA_VERSION,
  LocalSongFamilyReviewStore
} = require('../src/services/project/LocalSongFamilyReviewStore');
const {
  songFamilyRevision
} = require('../src/services/project/SongFamilyRevision');
const {
  normalizeSongDocument,
  parseSongDocument,
  serializeSongDocument
} = require('../src/services/project/SongDocument');
const {
  normalizeServiceProject,
  serializeServiceProject
} = require('../src/services/project/ServiceProject');
const {
  buildCurrentServiceNativeDraft
} = require('../src/services/project/CurrentServiceNativeDraft');
const {
  ReviewedSongRangeReplacementError,
  applyReviewedSongRangeReplacement,
  buildReviewedSongRangeReplacementProposal,
  normalizeReviewedSongRangeReplacementProposal
} = require('../src/services/project/ReviewedSongRangeReplacement');

const NOW = '2026-07-30T19:00:00.000Z';
const REVIEWED_AT = '2026-07-30T17:00:00.000Z';
const COMMITTED_AT = '2026-07-30T18:00:00.000Z';
const RENDER_REVISION = 'f'.repeat(64);
const BINDING = Object.freeze({
  id: 'service-2026-07-30',
  fingerprint: '9'.repeat(64),
  serviceDate: '2026-07-30',
  profileId: 'sanctuary'
});
const CHANNELS = Object.freeze([
  { id: 'english', label: 'English', language: 'en' },
  { id: 'russian', label: 'Russian', language: 'ru' },
  { id: 'media', label: 'Media', language: 'und' }
]);
const MAPPINGS = Object.freeze([{
  channelId: 'english',
  mode: 'content',
  songId: 'reviewed-family',
  songRevisionId: null,
  sourceRoleId: 'english'
}, {
  channelId: 'russian',
  mode: 'content',
  songId: 'reviewed-family-ru',
  songRevisionId: null,
  sourceRoleId: 'russian'
}, {
  channelId: 'media',
  mode: 'derive',
  from: 'english',
  transform: {
    id: 'first-lines',
    version: 1,
    maxLines: 2
  }
}]);

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
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

function canonicalHash(value) {
  return sha256(`${canonicalJson(value)}\n`);
}

function clone(value) {
  return structuredClone(value);
}

function expectCode(code) {
  return error => {
    assert.ok(
      error instanceof ReviewedSongRangeReplacementError,
      `expected ReviewedSongRangeReplacementError, got ${error?.constructor?.name}`
    );
    assert.equal(error.code, code);
    return true;
  };
}

function canonicalSong({
  id,
  title,
  language,
  translationOf = null,
  lines
}) {
  const song = normalizeSongDocument({
    schemaVersion: 1,
    id,
    title,
    language,
    translationOf,
    license: translationOf
      ? 'Direct translation permission'
      : 'CCLI service license',
    tags: [],
    authors: [],
    translators: [],
    composers: [],
    source: 'Reviewed local PowerPoint',
    attribution: '',
    extraMetadata: {},
    sections: lines.map((slideLines, index) => ({
      id: `p${index + 1}`,
      marker: `P${index + 1}`,
      label: `P${index + 1}`,
      slides: [{
        id: `p${index + 1}-slide-1`,
        lines: slideLines
      }]
    }))
  });
  const documentSource = serializeSongDocument(song);
  return {
    song,
    documentSource,
    revision: sha256(documentSource),
    finalTextSha256: sha256(JSON.stringify(lines))
  };
}

function capture({ roleId, deckSha256, lines, lane }) {
  const slides = lines.map((slideLines, index) => ({
    number: index + 2,
    lane,
    lines: slideLines,
    textSha256: sha256(JSON.stringify(slideLines))
  }));
  return {
    ordinal: 1,
    roleId,
    deckSha256,
    selectionOrigin: 'template-local',
    candidateId: 'slides-1-2-3',
    titleSlide: 1,
    capturedTextSha256: sha256(JSON.stringify(lines)),
    slides
  };
}

function reviewSnapshot() {
  const englishLines = [['English first line'], ['English second line']];
  const russianLines = [['Русская первая строка'], ['Русская вторая строка']];
  const english = canonicalSong({
    id: 'reviewed-family',
    title: 'Reviewed Family',
    language: 'en',
    lines: englishLines
  });
  const russian = canonicalSong({
    id: 'reviewed-family-ru',
    title: 'Проверенная семья',
    language: 'ru',
    translationOf: 'reviewed-family',
    lines: russianLines
  });
  const decks = {
    english: 'a'.repeat(64),
    russian: 'b'.repeat(64),
    media: 'c'.repeat(64)
  };
  return {
    schemaVersion: SONG_FAMILY_REVIEW_SNAPSHOT_SCHEMA_VERSION,
    kind: 'syncshow-song-family-review-snapshot',
    reviewScope: 'local-powerpoint-family',
    confirmations: {
      sourceConfirmed: true,
      rightsConfirmed: true,
      localCommitConfirmed: true,
      authorityScope: SONG_FAMILY_REVIEW_CONFIRMATION_AUTHORITY_SCOPE,
      communityAuthorityGranted: false
    },
    reviewedAt: REVIEWED_AT,
    serviceSet: {
      ...BINDING,
      extractor: {
        id: 'syncshow-current-service-pptx',
        version: 1
      },
      decks: Object.entries(decks).map(([roleId, deckSha256]) => ({
        roleId,
        sourceName: `${roleId}.pptx`,
        sourceSizeBytes: 4096,
        deckSha256,
        deckSlideCount: 20
      }))
    },
    family: {
      rootSongId: english.song.id,
      members: [{
        songId: english.song.id,
        familyRole: 'original',
        translationOf: null,
        action: 'create',
        expectedRevision: null,
        reviewedRevision: english.revision,
        finalTextSha256: english.finalTextSha256,
        documentSource: english.documentSource,
        localServiceRights: {
          scope: 'local-service-song-intake',
          basis: 'ccli-service-license',
          evidence: 'CCLI service license and exact SongSelect entry reviewed.',
          reviewedAt: REVIEWED_AT
        },
        captures: [capture({
          roleId: 'english',
          deckSha256: decks.english,
          lines: englishLines,
          lane: 'white'
        })]
      }, {
        songId: russian.song.id,
        familyRole: 'translation',
        translationOf: english.song.id,
        action: 'create',
        expectedRevision: null,
        reviewedRevision: russian.revision,
        finalTextSha256: russian.finalTextSha256,
        documentSource: russian.documentSource,
        localServiceRights: {
          scope: 'local-service-song-intake',
          basis: 'direct-permission',
          evidence: 'Written translation permission reviewed for this service.',
          reviewedAt: REVIEWED_AT
        },
        captures: [capture({
          roleId: 'russian',
          deckSha256: decks.russian,
          lines: russianLines,
          lane: 'yellow'
        })]
      }],
      occurrences: [2, 3].map((slideNumber, index) => ({
        occurrenceId: `slide-${slideNumber}`,
        action: 'new',
        sectionId: `p${index + 1}`,
        repeatOfOccurrenceId: null,
        evidence: [{
          songId: english.song.id,
          captureOrdinal: 1,
          slideNumber
        }, {
          songId: russian.song.id,
          captureOrdinal: 1,
          slideNumber
        }]
      }))
    }
  };
}

function nativeProject() {
  const descriptor = character => ({
    assetId: `sha256:${character.repeat(64)}`,
    sha256: character.repeat(64),
    size: 4096,
    width: 1920,
    height: 1080,
    orientation: 1
  });
  const characters = {
    english: ['1', '2', '3'],
    russian: ['4', '5', '6'],
    media: ['7', '8', 'd']
  };
  return buildCurrentServiceNativeDraft({
    binding: BINDING,
    title: 'Sunday Service',
    channels: CHANNELS,
    sources: CHANNELS.map(channel => ({
      roleId: channel.id,
      channelId: channel.id,
      fileName: `${channel.id}.pptx`,
      slides: characters[channel.id].map(descriptor)
    })),
    createdAt: REVIEWED_AT,
    renderRevisionId: RENDER_REVISION
  }).project;
}

function projectRevisionId(project) {
  return sha256(serializeServiceProject(project));
}

function receiptRequest(snapshotHash, snapshot) {
  const familyRevision = songFamilyRevision(
    snapshot.family.members.map(member => ({
      song: parseSongDocument(member.documentSource, {
        fileName: `${member.songId}.md`
      }),
      revision: member.reviewedRevision
    }))
  );
  return {
    snapshotHash,
    committedAt: COMMITTED_AT,
    familyRevision,
    results: snapshot.family.members.map(member => ({
      songId: member.songId,
      previousRevision: member.expectedRevision,
      resultingRevision: member.reviewedRevision
    }))
  };
}

async function fixture(t) {
  const rootPath = await fs.mkdtemp(
    path.join(os.tmpdir(), 'syncshow-reviewed-range-')
  );
  t.after(() => fs.rm(rootPath, { recursive: true, force: true }));
  const store = new LocalSongFamilyReviewStore({
    rootPath: path.join(rootPath, 'reviews')
  });
  const saved = await store.saveSnapshot(reviewSnapshot());
  const request = receiptRequest(saved.snapshotHash, saved.snapshot);
  await store.saveCommitReceipt(request);
  const reviewLookup = await store.findByFamilyRevision({
    rootSongId: saved.snapshot.family.rootSongId,
    familyRevision: request.familyRevision
  });
  const revisions = Object.fromEntries(
    saved.snapshot.family.members.map(member => [
      member.songId,
      member.reviewedRevision
    ])
  );
  const channelMappings = MAPPINGS.map(mapping => mapping.mode === 'content'
    ? { ...mapping, songRevisionId: revisions[mapping.songId] }
    : clone(mapping));
  const project = nativeProject();
  return {
    project,
    projectRevisionId: projectRevisionId(project),
    reviewLookup,
    channelMappings
  };
}

function build(fixtureValue, overrides = {}) {
  return buildReviewedSongRangeReplacementProposal({
    project: fixtureValue.project,
    projectRevisionId: fixtureValue.projectRevisionId,
    reviewLookup: fixtureValue.reviewLookup,
    channelMappings: fixtureValue.channelMappings,
    now: NOW,
    ...overrides
  });
}

function rehashLookup(rawLookup) {
  const lookup = clone(rawLookup);
  const membersById = new Map(
    lookup.snapshot.snapshot.family.members.map(member => [
      member.songId,
      member
    ])
  );
  lookup.receipt.occurrences =
    lookup.snapshot.snapshot.family.occurrences.map(occurrence => ({
      occurrenceId: occurrence.occurrenceId,
      action: occurrence.action,
      sectionId: occurrence.sectionId,
      repeatOfOccurrenceId: occurrence.repeatOfOccurrenceId,
      evidence: occurrence.evidence.map(evidence => {
        const capture = membersById.get(evidence.songId)?.captures
          .find(candidate =>
            candidate.ordinal === evidence.captureOrdinal);
        const slide = capture?.slides.find(candidate =>
          candidate.number === evidence.slideNumber);
        return {
          ...evidence,
          textSha256: slide?.textSha256 || '0'.repeat(64)
        };
      })
    }));
  const snapshotHash = canonicalHash(lookup.snapshot.snapshot);
  lookup.snapshot.snapshotHash = snapshotHash;
  lookup.receipt.snapshotHash = snapshotHash;
  lookup.receipt.schemaVersion = SONG_FAMILY_REVIEW_RECEIPT_SCHEMA_VERSION;
  delete lookup.receipt.receiptHash;
  const receiptHash = canonicalHash(lookup.receipt);
  lookup.receipt = { receiptHash, ...lookup.receipt };
  lookup.reviewStatus = {
    snapshotHash,
    reviewed: true,
    receipts: [clone(lookup.receipt)],
    skippedCorruptReceipts: 0
  };
  return lookup;
}

function withRecomputedProposalId(rawProposal) {
  const proposal = clone(rawProposal);
  delete proposal.id;
  return { ...proposal, id: canonicalHash(proposal) };
}

test('builds one canonical exact-evidence replacement proposal', async t => {
  const value = await fixture(t);
  const proposal = build(value);

  assert.equal(proposal.schemaVersion, 1);
  assert.equal(
    proposal.kind,
    'syncshow-reviewed-song-range-replacement-proposal'
  );
  assert.equal(proposal.cueCount, 3);
  assert.deepEqual(proposal.sourceRange.itemIds, [
    'powerpoint-position-0001',
    'powerpoint-position-0002',
    'powerpoint-position-0003'
  ]);
  assert.equal(proposal.sourceRange.renderRevisionId, RENDER_REVISION);
  assert.equal(proposal.replacementItem.kind, 'song');
  assert.equal(proposal.replacementItem.primaryChannelId, 'english');
  assert.equal(
    proposal.replacementItem.variants.media.mode,
    'derive'
  );
  assert.deepEqual(
    proposal.replacementItem.arrangement.map(entry => entry.sectionId),
    ['p1', 'p2']
  );
  assert.equal(
    proposal.replacementItem.sourceRangeReplacement.sourceProjectRevisionId,
    value.projectRevisionId
  );
  assert.equal(Object.isFrozen(proposal), true);
  assert.deepEqual(
    normalizeReviewedSongRangeReplacementProposal(clone(proposal)),
    proposal
  );
});

test('fails closed on manual captures, absent titles, and unequal positions', async t => {
  const value = await fixture(t);

  const manual = clone(value.reviewLookup);
  const manualCapture =
    manual.snapshot.snapshot.family.members[0].captures[0];
  manualCapture.selectionOrigin = 'manual';
  manualCapture.candidateId = null;
  manualCapture.titleSlide = null;
  assert.throws(
    () => build(value, { reviewLookup: rehashLookup(manual) }),
    expectCode('MANUAL_SOURCE_SELECTION')
  );

  const missingTitle = clone(value.reviewLookup);
  missingTitle.snapshot.snapshot.family.members[0]
    .captures[0].titleSlide = null;
  assert.throws(
    () => build(value, { reviewLookup: rehashLookup(missingTitle) }),
    expectCode('MISSING_TITLE_SLIDE')
  );

  const unequal = clone(value.reviewLookup);
  const russianMember = unequal.snapshot.snapshot.family.members.find(member =>
    member.songId === 'reviewed-family-ru');
  russianMember.captures[0].titleSlide = 4;
  russianMember.captures[0].candidateId = 'slides-4-5-6';
  russianMember.captures[0].slides.forEach((slide, index) => {
    slide.number = index + 5;
  });
  unequal.snapshot.snapshot.family.occurrences.forEach((occurrence, index) => {
    occurrence.evidence.find(evidence =>
      evidence.songId === 'reviewed-family-ru').slideNumber = index + 5;
  });
  unequal.receipt.occurrences =
    clone(unequal.snapshot.snapshot.family.occurrences);
  assert.throws(
    () => build(value, { reviewLookup: rehashLookup(unequal) }),
    expectCode('UNEQUAL_SOURCE_POSITIONS')
  );
});

test('fails closed on exclusions and nonconsecutive reviewed source positions', async t => {
  const value = await fixture(t);
  const excluded = clone(value.reviewLookup);
  const excludedOccurrence =
    excluded.snapshot.snapshot.family.occurrences[1];
  excludedOccurrence.action = 'exclude';
  excludedOccurrence.sectionId = null;
  excludedOccurrence.repeatOfOccurrenceId = null;
  excluded.receipt.occurrences =
    clone(excluded.snapshot.snapshot.family.occurrences);
  assert.throws(
    () => build(value, { reviewLookup: rehashLookup(excluded) }),
    expectCode('EXCLUDED_OCCURRENCE')
  );

  const gapped = clone(value.reviewLookup);
  for (const member of gapped.snapshot.snapshot.family.members) {
    member.captures[0].candidateId = 'slides-1-2-4';
    member.captures[0].slides[1].number = 4;
  }
  for (const occurrence of gapped.snapshot.snapshot.family.occurrences) {
    if (occurrence.occurrenceId === 'slide-3') {
      occurrence.evidence.forEach(evidence => {
        evidence.slideNumber = 4;
      });
    }
  }
  gapped.receipt.occurrences =
    clone(gapped.snapshot.snapshot.family.occurrences);
  assert.throws(
    () => build(value, { reviewLookup: rehashLookup(gapped) }),
    expectCode('NONCONSECUTIVE_SOURCE_RANGE')
  );
});

test('rejects hidden, missing, and cyclic output mappings', async t => {
  const value = await fixture(t);
  const hidden = clone(value.channelMappings);
  hidden[2] = { channelId: 'media', mode: 'hidden' };
  assert.throws(
    () => build(value, { channelMappings: hidden }),
    expectCode('HIDDEN_CHANNEL_NOT_ALLOWED')
  );

  assert.throws(
    () => build(value, {
      channelMappings: value.channelMappings.slice(0, 2)
    }),
    expectCode('INVALID_REPLACEMENT_REQUEST')
  );

  const cyclic = clone(value.channelMappings);
  cyclic[0] = { channelId: 'english', mode: 'inherit', from: 'media' };
  cyclic[2] = { channelId: 'media', mode: 'inherit', from: 'english' };
  assert.throws(
    () => build(value, { channelMappings: cyclic }),
    expectCode('CHANNEL_MAPPING_CYCLE')
  );
});

test('canonical proposal validation catches receipt and cue-count tampering', async t => {
  const value = await fixture(t);
  const proposal = build(value);

  const receiptTamper = clone(proposal);
  receiptTamper.replacementItem.sourceRangeReplacement.receiptHash =
    '0'.repeat(64);
  assert.throws(
    () => normalizeReviewedSongRangeReplacementProposal(
      withRecomputedProposalId(receiptTamper)
    ),
    expectCode('PROPOSAL_RECEIPT_MISMATCH')
  );

  const cueTamper = clone(proposal);
  cueTamper.replacementItem.arrangement.pop();
  assert.throws(
    () => normalizeReviewedSongRangeReplacementProposal(
      withRecomputedProposalId(cueTamper)
    ),
    expectCode('CUE_COUNT_MISMATCH')
  );
});

test('apply rejects altered, noncontiguous, and revision-drifted source projects', async t => {
  const value = await fixture(t);
  const proposal = build(value);

  const reordered = JSON.parse(serializeServiceProject(value.project));
  [
    reordered.rootItemIds[0],
    reordered.rootItemIds[1]
  ] = [
    reordered.rootItemIds[1],
    reordered.rootItemIds[0]
  ];
  assert.throws(
    () => applyReviewedSongRangeReplacement(
      normalizeServiceProject(reordered),
      proposal,
      { confirmed: true }
    ),
    expectCode('SOURCE_RANGE_CHANGED')
  );

  const edited = JSON.parse(serializeServiceProject(value.project));
  edited.title = 'Changed after proposal';
  assert.throws(
    () => applyReviewedSongRangeReplacement(
      normalizeServiceProject(edited),
      proposal,
      { confirmed: true }
    ),
    expectCode('PROJECT_REVISION_MISMATCH')
  );
});

test('atomically replaces the exact picture range and preserves its receipt', async t => {
  const value = await fixture(t);
  const proposal = build(value);
  const result = applyReviewedSongRangeReplacement(
    value.project,
    proposal,
    { confirmed: true }
  );

  assert.equal(result.changed, true);
  assert.deepEqual(result.project.rootItemIds, [
    proposal.replacementItem.id
  ]);
  assert.ok(result.project.items[proposal.replacementItem.id]);
  assert.deepEqual(
    result.project.items[proposal.replacementItem.id].sourceRangeReplacement,
    proposal.replacementItem.sourceRangeReplacement
  );
  assert.equal(
    result.project.items[proposal.replacementItem.id].arrangement.length,
    2
  );
  assert.equal(
    Object.keys(result.project.resources).length,
    2
  );
});
