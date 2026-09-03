'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  CurrentServiceSongFamilyReviewError,
  applyCurrentServiceSongFamilyReview,
  createCurrentServiceSongFamilyReview,
  currentServiceSongFamilyReviewSnapshot
} = require('../src/services/project/CurrentServiceSongFamilyReview');
const {
  LocalSongFamilyReviewStore,
  MAX_TOTAL_DOCUMENT_SOURCE_BYTES,
  SONG_FAMILY_REVIEW_CONFIRMATION_AUTHORITY_SCOPE,
  SONG_FAMILY_REVIEW_SNAPSHOT_SCHEMA_VERSION
} = require('../src/services/project/LocalSongFamilyReviewStore');
const {
  MAX_SOURCE_BYTES,
  normalizeSongDocument,
  serializeSongDocument
} = require('../src/services/project/SongDocument');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function localOnlyConfirmations() {
  return {
    sourceConfirmed: true,
    rightsConfirmed: true,
    localCommitConfirmed: true,
    authorityScope: SONG_FAMILY_REVIEW_CONFIRMATION_AUTHORITY_SCOPE,
    communityAuthorityGranted: false
  };
}

function canonicalCurrent({
  id,
  title,
  language,
  translationOf = null,
  lines,
  license = '',
  attribution = '',
  authors = []
}) {
  const song = normalizeSongDocument({
    schemaVersion: 1,
    id,
    title,
    language,
    translationOf,
    license,
    attribution,
    tags: [],
    authors,
    translators: [],
    composers: [],
    source: 'Existing local song',
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
    revision: sha256(Buffer.from(documentSource, 'utf8'))
  };
}

function capturedMember({
  memberKey,
  songId,
  title,
  language,
  roleId,
  roleLabel,
  fileName,
  deckSha256,
  deckSlideCount,
  slideNumbers,
  slideLanes,
  lines,
  candidateId = null,
  titleSlide = null,
  titleCardLines = null,
  warningMessage = 'Review provisional section labels.'
}) {
  return {
    memberKey,
    songId,
    title,
    language,
    source: {
      roleId,
      roleLabel,
      fileName,
      sourceSizeBytes: 123_456,
      deckSha256,
      deckSlideCount,
      sourceLabel: `Reviewed ${roleLabel}: ${fileName}`
    },
    selection: {
      selectionOrigin: candidateId ? 'template-local' : 'manual',
      candidateId,
      titleSlide,
      slideNumbers,
      slideLanes
    },
    titleCardEvidence: candidateId
      ? {
          kind: 'template-local',
          slideNumber: titleSlide,
          lines: titleCardLines || [
            title,
            `${roleLabel} title-card credits`
          ]
        }
      : {
          kind: 'none',
          slideNumber: null,
          lines: []
        },
    draft: {
      song: normalizeSongDocument({
        schemaVersion: 1,
        id: `${songId}-draft`,
        title,
        language,
        translationOf: null,
        license: '',
        tags: [],
        authors: [],
        translators: [],
        composers: [],
        source: `Reviewed ${roleLabel}: ${fileName}`,
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
      }),
      warnings: [{
        code: 'PROVISIONAL_SECTION_LABELS',
        message: warningMessage
      }],
      provenance: {
        deckSha256,
        deckSlideCount,
        slideNumbers,
        slideLanes
      }
    }
  };
}

function fixture(overrides = {}) {
  const rootLines = [
    ['Grace has found me'],
    ['Christ is enough'],
    ['Grace has found me']
  ];
  const translationLines = [
    ['Благодать нашла меня'],
    ['Христос достаточен'],
    ['Благодать нашла меня']
  ];
  const currentRoot = canonicalCurrent({
    id: 'grace-song',
    title: 'Grace Song',
    language: 'en',
    lines: rootLines.slice(0, 2),
    license: 'CCLI',
    attribution: 'Used under the church license.',
    authors: ['A. Writer']
  });
  const untouched = canonicalCurrent({
    id: 'grace-song-es',
    title: 'Canción de Gracia',
    language: 'es',
    translationOf: 'grace-song',
    lines: [['Gracia me encontró'], ['Cristo es suficiente']]
  });
  return {
    serviceSet: {
      id: 'service-2026-07-28',
      fingerprint: 'f'.repeat(64),
      serviceDate: '2026-07-28',
      profileId: 'main-sanctuary',
      name: 'Sunday Service'
    },
    members: [
      capturedMember({
        memberKey: 'root',
        songId: 'grace-song',
        title: 'Grace Song',
        language: 'en',
        roleId: 'english',
        roleLabel: 'English',
        fileName: 'Service ENG.pptx',
        deckSha256: 'a'.repeat(64),
        deckSlideCount: 50,
        slideNumbers: [10, 11, 12],
        slideLanes: ['white', 'white', 'yellow'],
        lines: rootLines,
        candidateId: 'slides-9-10-12',
        titleSlide: 9
      }),
      capturedMember({
        memberKey: 'translation',
        songId: 'grace-song-ru',
        title: 'Песня Благодати',
        language: 'ru',
        roleId: 'russian',
        roleLabel: 'Russian',
        fileName: 'Service RUS.pptx',
        deckSha256: 'b'.repeat(64),
        deckSlideCount: 60,
        slideNumbers: [20, 21, 22],
        slideLanes: ['yellow', 'yellow', 'white'],
        lines: translationLines
      })
    ],
    currentDocuments: [currentRoot, untouched],
    ...overrides
  };
}

function metadata(prepared) {
  return prepared.summary.family.members.map(member => ({
    memberKey: member.memberKey,
    license: member.metadata.license || (member.memberKey === 'translation'
      ? 'CCLI'
      : ''),
    attribution: member.metadata.attribution,
    tags: member.metadata.tags,
    authors: member.metadata.authors,
    translators: member.memberKey === 'translation'
      ? ['R. Translator']
      : member.metadata.translators,
    composers: member.metadata.composers,
    localServiceRights: {
      basis: member.memberKey === 'translation'
        ? 'direct-permission'
        : 'ccli-service-license',
      evidence: member.memberKey === 'translation'
        ? 'Written translation permission reviewed for this local service.'
        : 'CCLI service license and exact SongSelect entry reviewed.'
    }
  }));
}

test('distinct decks pair by ordinal and commit a complete family with untouched reuse', async t => {
  const input = fixture();
  const [currentRoot, untouched] = input.currentDocuments;
  const prepared = createCurrentServiceSongFamilyReview(input);

  assert.equal(prepared.summary.family.members[0].familyRole, 'root');
  assert.equal(prepared.summary.family.members[1].familyRole, 'translation');
  assert.equal(
    prepared.summary.family.members[0].saveDisposition,
    'existing-may-update'
  );
  assert.equal(
    prepared.summary.family.members[1].saveDisposition,
    'create'
  );
  assert.deepEqual(
    prepared.summary.family.members[0].titleCardEvidence,
    {
      kind: 'template-local',
      slideNumber: 9,
      lines: ['Grace Song', 'English title-card credits']
    }
  );
  assert.deepEqual(
    prepared.summary.family.members[1].titleCardEvidence,
    {
      kind: 'none',
      slideNumber: null,
      lines: []
    }
  );
  assert.deepEqual(
    {
      songId: prepared.summary.family.members[0].currentIdentity.songId,
      revision: prepared.summary.family.members[0].currentIdentity.revision,
      title: prepared.summary.family.members[0].currentIdentity.title,
      language: prepared.summary.family.members[0].currentIdentity.language,
      sectionCount:
        prepared.summary.family.members[0].currentIdentity.sectionCount,
      slideCount:
        prepared.summary.family.members[0].currentIdentity.slideCount,
      lineCount:
        prepared.summary.family.members[0].currentIdentity.lineCount
    },
    {
      songId: 'grace-song',
      revision: currentRoot.revision,
      title: 'Grace Song',
      language: 'en',
      sectionCount: 2,
      slideCount: 2,
      lineCount: 2
    }
  );
  assert.equal(
    prepared.summary.family.members[1].currentIdentity,
    null
  );
  assert.deepEqual(
    prepared.summary.retainedTranslations.map(identity => ({
      songId: identity.songId,
      revision: identity.revision,
      title: identity.title,
      language: identity.language,
      translationOf: identity.translationOf,
      sectionCount: identity.sectionCount,
      slideCount: identity.slideCount,
      lineCount: identity.lineCount
    })),
    [{
      songId: 'grace-song-es',
      revision: untouched.revision,
      title: 'Canción de Gracia',
      language: 'es',
      translationOf: 'grace-song',
      sectionCount: 2,
      slideCount: 2,
      lineCount: 2
    }]
  );
  assert.deepEqual(prepared.summary.family.members[0].metadata, {
    license: 'CCLI',
    attribution: 'Used under the church license.',
    tags: [],
    authors: ['A. Writer'],
    translators: [],
    composers: []
  });
  assert.equal(prepared.summary.family.members[1].metadata.license, '');
  assert.deepEqual(
    prepared.summary.occurrences.map(item =>
      item.members.map(member => member.slideNumber)),
    [[10, 20], [11, 21], [12, 22]]
  );
  assert.deepEqual(
    prepared.summary.occurrences[0].members.map(member => member.lines),
    [['Grace has found me'], ['Благодать нашла меня']]
  );
  assert.deepEqual(
    prepared.summary.occurrences.map(item =>
      item.suggestedDecision.action),
    ['new', 'new', 'repeat']
  );
  assert.equal(
    prepared.summary.occurrences[2].suggestedDecision.repeatOfOccurrenceId,
    'occurrence-1'
  );

  const applied = applyCurrentServiceSongFamilyReview(prepared, {
    decisions: prepared.summary.occurrences.map(item =>
      item.suggestedDecision),
    metadata: metadata(prepared)
  });
  const snapshot = currentServiceSongFamilyReviewSnapshot(
    prepared,
    applied,
    {
      reviewedAt: '2026-07-28T18:00:00.000Z',
      confirmations: localOnlyConfirmations()
    }
  );

  assert.equal(
    snapshot.schemaVersion,
    SONG_FAMILY_REVIEW_SNAPSHOT_SCHEMA_VERSION
  );
  assert.deepEqual(snapshot.confirmations, localOnlyConfirmations());
  assert.deepEqual(
    snapshot.serviceSet.decks.map(deck => deck.roleId),
    ['english', 'russian']
  );
  assert.deepEqual(
    snapshot.family.members.map(member => [
      member.songId,
      member.action,
      member.captures.length
    ]),
    [
      ['grace-song', 'update', 1],
      ['grace-song-es', 'reuse', 0],
      ['grace-song-ru', 'create', 1]
    ]
  );
  assert.deepEqual(
    snapshot.family.occurrences[0].evidence.map(item => [
      item.songId,
      item.slideNumber
    ]),
    [['grace-song', 10], ['grace-song-ru', 20]]
  );
  assert.equal(snapshot.family.occurrences[2].action, 'repeat');
  assert.deepEqual(
    snapshot.family.members.map(member => [
      member.songId,
      member.localServiceRights
    ]),
    [
      ['grace-song', {
        scope: 'local-service-song-intake',
        basis: 'ccli-service-license',
        evidence: 'CCLI service license and exact SongSelect entry reviewed.',
        reviewedAt: '2026-07-28T18:00:00.000Z'
      }],
      ['grace-song-es', null],
      ['grace-song-ru', {
        scope: 'local-service-song-intake',
        basis: 'direct-permission',
        evidence:
          'Written translation permission reviewed for this local service.',
        reviewedAt: '2026-07-28T18:00:00.000Z'
      }]
    ]
  );
  assert.equal(
    snapshot.family.members.some(member =>
      member.documentSource.includes('local-service-song-intake')
      || member.documentSource.includes('SongSelect entry reviewed')),
    false
  );

  const parent = await fs.mkdtemp(
    path.join(os.tmpdir(), 'syncshow-family-backend-')
  );
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const store = new LocalSongFamilyReviewStore({
    rootPath: path.join(await fs.realpath(parent), 'reviews')
  });
  const saved = await store.saveSnapshot(snapshot);
  assert.match(saved.snapshotHash, /^[a-f0-9]{64}$/);
  assert.equal(saved.snapshot.family.members.length, 3);
});

test('saved language labels remain exact and bounded in public family identities', () => {
  const input = fixture();
  input.currentDocuments[0] = canonicalCurrent({
    id: 'grace-song',
    title: 'Grace Song',
    language: 'Spanish',
    lines: [['Grace has found me'], ['Christ is enough']]
  });
  input.currentDocuments[1] = canonicalCurrent({
    id: 'grace-song-es',
    title: 'Canción de Gracia',
    language: 'EN',
    translationOf: 'grace-song',
    lines: [['Gracia me encontró'], ['Cristo es suficiente']]
  });

  const prepared = createCurrentServiceSongFamilyReview(input);

  assert.equal(
    prepared.summary.family.members[0].currentIdentity.language,
    'Spanish'
  );
  assert.equal(prepared.summary.retainedTranslations[0].language, 'EN');
});

test('prospective family capacity rejects a new thirty-third member but permits replacement', () => {
  const root = canonicalCurrent({
    id: 'grace-song',
    title: 'Grace Song',
    language: 'en',
    lines: [['Grace has found me'], ['Christ is enough']]
  });
  const translations = Array.from({ length: 31 }, (_value, index) =>
    canonicalCurrent({
      id: `grace-song-translation-${index + 1}`,
      title: `Grace Song Translation ${index + 1}`,
      language: `Language ${index + 1}`,
      translationOf: 'grace-song',
      lines: [['Translated grace'], ['Translated Christ']]
    }));
  const currentDocuments = [root, ...translations];

  assert.throws(
    () => createCurrentServiceSongFamilyReview(fixture({
      currentDocuments
    })),
    error => error.code === 'CURRENT_SERVICE_SONG_FAMILY_MEMBER_LIMIT'
  );

  const replacement = fixture({ currentDocuments });
  replacement.members[1].songId = translations[0].song.id;
  assert.doesNotThrow(
    () => createCurrentServiceSongFamilyReview(replacement)
  );
});

test('prospective family capacity reserves complete captured sources before review', () => {
  const denseLines = Array.from(
    { length: 200 },
    () => ['x'.repeat(900), 'y'.repeat(900)]
  );
  const retained = [];
  let retainedBytes = 0;
  const reservationThreshold =
    MAX_TOTAL_DOCUMENT_SOURCE_BYTES - (2 * MAX_SOURCE_BYTES);
  for (let index = 1; retainedBytes <= reservationThreshold; index += 1) {
    const document = canonicalCurrent({
      id: `dense-translation-${index}`,
      title: `Dense Translation ${index}`,
      language: `Dense ${index}`,
      translationOf: 'grace-song',
      lines: denseLines
    });
    const documentBytes = Buffer.byteLength(document.documentSource, 'utf8');
    assert.ok(documentBytes <= MAX_SOURCE_BYTES);
    assert.ok(
      retainedBytes + documentBytes <= MAX_TOTAL_DOCUMENT_SOURCE_BYTES,
      'test fixture must remain a valid current-family aggregate'
    );
    retained.push(document);
    retainedBytes += documentBytes;
  }
  assert.ok(retainedBytes > reservationThreshold);

  const input = fixture({
    currentDocuments: [
      canonicalCurrent({
        id: 'grace-song',
        title: 'Grace Song',
        language: 'en',
        lines: [['Grace has found me'], ['Christ is enough']]
      }),
      ...retained
    ]
  });
  assert.throws(
    () => createCurrentServiceSongFamilyReview(input),
    error => error.code === 'CURRENT_SERVICE_SONG_FAMILY_SOURCE_LIMIT'
  );
});

test('shared deck requires the same slide range while distinct decks only require equal counts', () => {
  const base = fixture();
  const shared = structuredClone(base);
  shared.members[1].source = {
    ...shared.members[0].source
  };
  shared.members[1].draft.provenance.deckSha256 =
    shared.members[0].source.deckSha256;
  shared.members[1].draft.provenance.deckSlideCount =
    shared.members[0].source.deckSlideCount;
  assert.throws(
    () => createCurrentServiceSongFamilyReview(shared),
    error => {
      assert.ok(error instanceof CurrentServiceSongFamilyReviewError);
      assert.equal(
        error.code,
        'CURRENT_SERVICE_SONG_FAMILY_SHARED_DECK_RANGE_MISMATCH'
      );
      return true;
    }
  );

  const sharedBytesAcrossRoles = fixture();
  sharedBytesAcrossRoles.members[1].source.deckSha256 =
    sharedBytesAcrossRoles.members[0].source.deckSha256;
  sharedBytesAcrossRoles.members[1].draft.provenance.deckSha256 =
    sharedBytesAcrossRoles.members[0].source.deckSha256;
  assert.throws(
    () => createCurrentServiceSongFamilyReview(sharedBytesAcrossRoles),
    error => {
      assert.ok(error instanceof CurrentServiceSongFamilyReviewError);
      assert.equal(
        error.code,
        'CURRENT_SERVICE_SONG_FAMILY_SHARED_DECK_RANGE_MISMATCH'
      );
      return true;
    }
  );

  const unequal = fixture();
  unequal.members[1] = capturedMember({
    ...unequal.members[1],
    memberKey: 'translation',
    songId: 'grace-song-ru',
    title: 'Песня Благодати',
    language: 'ru',
    roleId: 'russian',
    roleLabel: 'Russian',
    fileName: 'Service RUS.pptx',
    deckSha256: 'b'.repeat(64),
    deckSlideCount: 60,
    slideNumbers: [20, 21],
    slideLanes: ['yellow', 'yellow'],
    lines: [['Один'], ['Два']]
  });
  assert.throws(
    () => createCurrentServiceSongFamilyReview(unequal),
    error => {
      assert.equal(
        error.code,
        'CURRENT_SERVICE_SONG_FAMILY_OCCURRENCE_COUNT_MISMATCH'
      );
      return true;
    }
  );
});

test('template evidence binds the candidate id to exact consecutive title and body slides', () => {
  const input = fixture();
  input.members[0].selection.candidateId = 'slides-8-10-12';
  assert.throws(
    () => createCurrentServiceSongFamilyReview(input),
    error => {
      assert.ok(error instanceof CurrentServiceSongFamilyReviewError);
      assert.equal(error.code, 'INVALID_CURRENT_SERVICE_SONG_FAMILY');
      return true;
    }
  );
});

test('title-card and complete occurrence evidence reject unsupported and oversized fields', () => {
  const leaked = fixture();
  leaked.members[0].titleCardEvidence.documentSource =
    '/private/church/service.pptx';
  assert.throws(
    () => createCurrentServiceSongFamilyReview(leaked),
    error => error.code === 'INVALID_CURRENT_SERVICE_SONG_FAMILY'
  );

  const manualClaim = fixture();
  manualClaim.members[1].titleCardEvidence = {
    kind: 'template-local',
    slideNumber: 19,
    lines: ['Unbound title']
  };
  assert.throws(
    () => createCurrentServiceSongFamilyReview(manualClaim),
    error => error.code === 'INVALID_CURRENT_SERVICE_SONG_FAMILY'
  );

  const oversizedTitle = fixture();
  oversizedTitle.members[0].titleCardEvidence.lines =
    Array.from({ length: 33 }, () => 'x'.repeat(1_000));
  assert.throws(
    () => createCurrentServiceSongFamilyReview(oversizedTitle),
    error => error.code === 'CURRENT_SERVICE_SONG_FAMILY_TOO_LARGE'
  );

  const oversizedOccurrence = fixture();
  oversizedOccurrence.members[0].draft.song.sections[0].slides[0].lines =
    ['x'.repeat(1_001)];
  assert.throws(
    () => createCurrentServiceSongFamilyReview(oversizedOccurrence),
    error => error.code === 'INVALID_CURRENT_SERVICE_SONG_FAMILY'
  );
});

test('path-free summaries are bounded without splitting a surrogate pair', () => {
  const input = fixture({
    currentDocuments: []
  });
  input.members = [capturedMember({
    memberKey: 'root',
    songId: 'emoji-song',
    title: 'Emoji Song',
    language: 'en',
    roleId: 'bilingual',
    roleLabel: 'Bilingual',
    fileName: 'Service.pptx',
    deckSha256: 'c'.repeat(64),
    deckSlideCount: 5,
    slideNumbers: [2],
    slideLanes: ['all'],
    lines: [[`${'a'.repeat(238)}😀tail`]]
  })];
  const prepared = createCurrentServiceSongFamilyReview(input);
  const preview = prepared.summary.occurrences[0].members[0].preview;

  assert.ok(preview.length <= 240);
  assert.equal(/[\uD800-\uDBFF]…$/u.test(preview), false);
  assert.equal(preview.endsWith('…'), true);
  assert.equal(JSON.stringify(prepared.summary).includes('/private/'), false);
  assert.equal(JSON.stringify(prepared.summary).includes('deckSha256'), false);
  assert.equal(
    JSON.stringify(prepared.summary).includes('documentSource'),
    false
  );
});

test('invalid calendar service dates and changed untouched translation structure fail closed', () => {
  const invalidDate = fixture();
  invalidDate.serviceSet.serviceDate = '2026-02-31';
  assert.throws(
    () => createCurrentServiceSongFamilyReview(invalidDate),
    error => error.code === 'INVALID_CURRENT_SERVICE_SONG_FAMILY'
  );

  const input = fixture();
  input.currentDocuments[1] = canonicalCurrent({
    id: 'grace-song-es',
    title: 'Canción de Gracia',
    language: 'es',
    translationOf: 'grace-song',
    lines: [['Only one section']]
  });
  const prepared = createCurrentServiceSongFamilyReview(input);
  const applied = applyCurrentServiceSongFamilyReview(prepared, {
    decisions: prepared.summary.occurrences.map(item =>
      item.suggestedDecision),
    metadata: metadata(prepared)
  });
  assert.throws(
    () => currentServiceSongFamilyReviewSnapshot(
      prepared,
      applied,
      {
        reviewedAt: '2026-07-28T18:00:00.000Z',
        confirmations: localOnlyConfirmations()
      }
    ),
    error => {
      assert.equal(
        error.code,
        'CURRENT_SERVICE_SONG_FAMILY_STRUCTURE_MISMATCH'
      );
      return true;
    }
  );
});

test('captured members require separate SongDocument license and strict local rights evidence', () => {
  const prepared = createCurrentServiceSongFamilyReview(fixture());
  const rawMetadata = metadata(prepared);
  rawMetadata[1].license = '';
  assert.throws(
    () => applyCurrentServiceSongFamilyReview(prepared, {
      decisions: prepared.summary.occurrences.map(item =>
        item.suggestedDecision),
      metadata: rawMetadata
    }),
    error => {
      assert.equal(
        error.code,
        'INVALID_CURRENT_SERVICE_SONG_FAMILY'
      );
      return true;
    }
  );

  const missingEvidence = metadata(prepared);
  missingEvidence[0].localServiceRights.evidence = '';
  assert.throws(
    () => applyCurrentServiceSongFamilyReview(prepared, {
      decisions: prepared.summary.occurrences.map(item =>
        item.suggestedDecision),
      metadata: missingEvidence
    }),
    error => error.code ===
      'INVALID_CURRENT_SERVICE_SONG_FAMILY_METADATA'
  );

  const communityField = metadata(prepared);
  communityField[0].localServiceRights.communityVisibility = 'public';
  assert.throws(
    () => applyCurrentServiceSongFamilyReview(prepared, {
      decisions: prepared.summary.occurrences.map(item =>
        item.suggestedDecision),
      metadata: communityField
    }),
    error => error.code ===
      'INVALID_CURRENT_SERVICE_SONG_FAMILY_METADATA'
  );
});
