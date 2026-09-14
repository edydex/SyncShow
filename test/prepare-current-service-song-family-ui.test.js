'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const controllerPath = path.join(
  root,
  'src',
  'renderer',
  'prepare-controller.js'
);
const controllerSource = fs.readFileSync(controllerPath, 'utf8');
const htmlSource = fs.readFileSync(
  path.join(root, 'src', 'renderer', 'index.html'),
  'utf8'
);
const stylesSource = fs.readFileSync(
  path.join(root, 'src', 'renderer', 'styles.css'),
  'utf8'
);

function plain(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function rendererExports() {
  const window = {};
  vm.runInNewContext(
    controllerSource,
    { console, window },
    { filename: controllerPath }
  );
  return window.SyncShowPrepare;
}

function memberRequest(overrides = {}) {
  return {
    memberKey: 'root',
    proposalToken: 'p'.repeat(32),
    songId: 'all-i-have-is-christ-en',
    title: 'All I Have Is Christ',
    language: 'en',
    lane: 'white',
    startSlide: 12,
    endSlide: 13,
    slideLanes: ['white', 'yellow'],
    candidateId: 'slides-11-12-13',
    ...overrides
  };
}

function familyMember(overrides = {}) {
  const metadata = {
    license: 'CCLI church license',
    attribution: 'Words and music by Jordan Kauflin',
    tags: ['grace'],
    authors: ['Jordan Kauflin'],
    translators: [],
    composers: ['Jordan Kauflin']
  };
  return {
    memberKey: 'root',
    songId: 'all-i-have-is-christ-en',
    title: 'All I Have Is Christ',
    language: 'en',
    familyRole: 'root',
    source: {
      roleId: 'english',
      roleLabel: 'English',
      fileName: '07-26-2026 Service ENG.pptx'
    },
    slideCount: 2,
    saveDisposition: 'existing-may-update',
    currentIdentity: {
      songId: 'all-i-have-is-christ-en',
      revision: 'a'.repeat(64),
      title: 'All I Have Is Christ',
      language: 'en',
      translationOf: null,
      sectionCount: 2,
      slideCount: 2,
      lineCount: 4,
      metadata
    },
    titleCardEvidence: {
      kind: 'template-local',
      slideNumber: 11,
      lines: [
        'All I Have Is Christ',
        'Words and music by Jordan Kauflin'
      ]
    },
    metadata,
    ...overrides
  };
}

function occurrence(
  ordinal,
  rootPreview,
  translationPreview,
  suggestedDecision
) {
  return {
    occurrenceId: `occurrence-${ordinal}`,
    ordinal,
    members: [
      {
        memberKey: 'root',
        slideNumber: 11 + ordinal,
        lane: ordinal === 1 ? 'white' : 'yellow',
        preview: rootPreview,
        lines: [rootPreview]
      },
      {
        memberKey: 'translation',
        slideNumber: 21 + ordinal,
        lane: 'yellow',
        preview: translationPreview,
        lines: [translationPreview]
      }
    ],
    suggestedDecision: {
      occurrenceId: `occurrence-${ordinal}`,
      action: suggestedDecision?.action || 'new',
      repeatOfOccurrenceId:
        suggestedDecision?.repeatOfOccurrenceId || null,
      note: suggestedDecision?.note || ''
    }
  };
}

function rawReview(overrides = {}) {
  return {
    reviewToken: 'r'.repeat(32),
    expiresAt: '2026-07-28T23:00:00.000Z',
    family: {
      rootSongId: 'all-i-have-is-christ-en',
      members: [
        familyMember(),
        familyMember({
          memberKey: 'translation',
          songId: 'christ-is-all-ru',
          title: 'Христос — всё',
          language: 'ru',
          familyRole: 'translation',
          source: {
            roleId: 'russian',
            roleLabel: 'Russian',
            fileName: '07-26-2026 Служение RUS.pptx'
          },
          saveDisposition: 'create',
          currentIdentity: null,
          titleCardEvidence: {
            kind: 'none',
            slideNumber: null,
            lines: []
          },
          metadata: {
            license: '',
            attribution: '',
            tags: [],
            authors: [],
            translators: [],
            composers: []
          }
        })
      ]
    },
    retainedTranslations: [{
      songId: 'all-i-have-is-christ-es',
      revision: 'b'.repeat(64),
      title: 'Cristo es todo',
      language: 'es',
      translationOf: 'all-i-have-is-christ-en',
      sectionCount: 2,
      slideCount: 2,
      lineCount: 4,
      metadata: {
        license: 'CCLI church license',
        attribution: 'Spanish translation by Local Church',
        tags: ['grace'],
        authors: ['Jordan Kauflin'],
        translators: ['Local Church'],
        composers: ['Jordan Kauflin']
      }
    }],
    occurrences: [
      occurrence(1, 'Hallelujah! All I have is Christ', 'Аллилуйя! Христос — всё'),
      occurrence(
        2,
        'Hallelujah! All I have is Christ',
        'Аллилуйя! Христос — всё',
        {
          action: 'repeat',
          repeatOfOccurrenceId: 'occurrence-1',
          note: 'Exact in every captured language.'
        }
      )
    ],
    warnings: [{
      code: 'REVIEW_SOURCE_WORDING',
      message: 'Confirm punctuation against the source slides.'
    }],
    confirmations: {
      sourceRequired: true,
      rightsRequired: true,
      localCommitRequired: true
    },
    ...overrides
  };
}

test('family begin request is exact, ordered, path-free, and supports two decks', () => {
  const { currentServiceSongFamilyBeginRequest } = rendererExports();
  const request = currentServiceSongFamilyBeginRequest([
    memberRequest(),
    memberRequest({
      memberKey: 'translation',
      proposalToken: 'q'.repeat(32),
      songId: 'christ-is-all-ru',
      title: 'Христос — всё',
      language: 'ru',
      lane: 'yellow',
      startSlide: 22,
      endSlide: 23,
      slideLanes: ['yellow', 'yellow'],
      candidateId: null
    })
  ]);

  assert.deepEqual(plain(request), {
    rootMemberKey: 'root',
    members: [
      {
        memberKey: 'root',
        proposalToken: 'p'.repeat(32),
        songId: 'all-i-have-is-christ-en',
        title: 'All I Have Is Christ',
        language: 'en',
        lane: 'white',
        startSlide: 12,
        endSlide: 13,
        slideLanes: ['white', 'yellow'],
        candidateId: 'slides-11-12-13'
      },
      {
        memberKey: 'translation',
        proposalToken: 'q'.repeat(32),
        songId: 'christ-is-all-ru',
        title: 'Христос — всё',
        language: 'ru',
        lane: 'yellow',
        startSlide: 22,
        endSlide: 23,
        slideLanes: ['yellow', 'yellow'],
        candidateId: null
      }
    ]
  });
  assert.equal(
    /sourcePath|pinnedPath|sha256|visibility|community|documentSource/u
      .test(JSON.stringify(request)),
    false
  );
  assert.throws(
    () => currentServiceSongFamilyBeginRequest([
      {
        ...memberRequest(),
        sourcePath: '/private/church/service.pptx'
      }
    ]),
    /unsupported/
  );
  assert.throws(
    () => currentServiceSongFamilyBeginRequest([
      memberRequest(),
      memberRequest({ memberKey: 'translation' })
    ]),
    /distinct Song Library IDs/
  );
  assert.throws(
    () => currentServiceSongFamilyBeginRequest([
      memberRequest(),
      memberRequest({
        memberKey: 'translation',
        proposalToken: 'q'.repeat(32),
        songId: 'christ-is-all-ru',
        language: 'ru',
        startSlide: 22,
        endSlide: 22,
        slideLanes: ['yellow']
      })
    ]),
    /same number of lyric occurrences/
  );
  assert.throws(
    () => currentServiceSongFamilyBeginRequest([
      memberRequest(),
      memberRequest({
        memberKey: 'translation',
        songId: 'christ-is-all-ru',
        language: 'ru',
        startSlide: 22,
        endSlide: 23
      })
    ]),
    /same slide range/
  );
  assert.throws(
    () => currentServiceSongFamilyBeginRequest(
      [
        memberRequest(),
        memberRequest({
          memberKey: 'translation',
          proposalToken: 'q'.repeat(32),
          songId: 'christ-is-all-ru',
          language: 'ru',
          startSlide: 22,
          endSlide: 23
        })
      ],
      ['a'.repeat(64), 'a'.repeat(64)]
    ),
    /same slide range/
  );
  assert.throws(
    () => currentServiceSongFamilyBeginRequest([
      memberRequest({ language: 'English' })
    ]),
    /Review every required PowerPoint song-family field/
  );
});

test('review response is strict, path-free, complete in every language, and keeps saved rights', () => {
  const { normalizeCurrentServiceSongFamilyReview } = rendererExports();
  const review = normalizeCurrentServiceSongFamilyReview(rawReview());

  assert.deepEqual(
    plain(review.family.members[0].metadata),
    familyMember().metadata
  );
  assert.equal(
    review.family.members[0].saveDisposition,
    'existing-may-update'
  );
  assert.equal(review.family.members[1].saveDisposition, 'create');
  assert.equal(
    review.family.members[0].currentIdentity.revision,
    'a'.repeat(64)
  );
  assert.deepEqual(
    plain(review.family.members[0].titleCardEvidence.lines),
    [
      'All I Have Is Christ',
      'Words and music by Jordan Kauflin'
    ]
  );
  assert.equal(
    review.family.members[1].titleCardEvidence.kind,
    'none'
  );
  assert.equal(review.retainedTranslations[0].songId, 'all-i-have-is-christ-es');
  assert.equal(review.occurrences[0].members.length, 2);
  assert.deepEqual(
    plain(review.occurrences[0].members[0].lines),
    ['Hallelujah! All I have is Christ']
  );
  assert.equal(Object.isFrozen(review), true);
  assert.equal(Object.isFrozen(review.family.members[0].metadata), true);
  assert.equal(
    /sourcePath|pinnedPath|documentSource|visibility|publication/u.test(
      JSON.stringify(review)
    ),
    false
  );

  const missingTranslation = rawReview();
  missingTranslation.occurrences = [
    {
      ...missingTranslation.occurrences[0],
      members: [missingTranslation.occurrences[0].members[0]]
    },
    missingTranslation.occurrences[1]
  ];
  assert.throws(
    () => normalizeCurrentServiceSongFamilyReview(missingTranslation),
    /invalid PowerPoint song occurrence/
  );

  const leakedPath = rawReview();
  leakedPath.family = {
    ...leakedPath.family,
    members: [
      {
        ...leakedPath.family.members[0],
        sourcePath: '/private/church/service.pptx'
      },
      leakedPath.family.members[1]
    ]
  };
  assert.throws(
    () => normalizeCurrentServiceSongFamilyReview(leakedPath),
    /unsupported PowerPoint song-family member details/
  );
});

test('stored language labels survive review and commit normalization exactly', () => {
  const {
    normalizeCurrentServiceSongFamilyCommitResult,
    normalizeCurrentServiceSongFamilyReview
  } = rendererExports();
  const payload = rawReview();
  payload.family.members[0].currentIdentity.language = 'Spanish';
  payload.retainedTranslations[0].language = 'EN';
  const review = normalizeCurrentServiceSongFamilyReview(payload);

  assert.equal(
    review.family.members[0].currentIdentity.language,
    'Spanish'
  );
  assert.equal(review.retainedTranslations[0].language, 'EN');

  const result = normalizeCurrentServiceSongFamilyCommitResult({
    familyId: review.family.rootSongId,
    familyRevision: 'f'.repeat(64),
    members: [{
      songId: 'all-i-have-is-christ-en',
      language: 'en',
      translationOf: null,
      action: 'update',
      resultingRevision: 'a'.repeat(64)
    }, {
      songId: 'all-i-have-is-christ-es',
      language: 'EN',
      translationOf: review.family.rootSongId,
      action: 'reuse',
      resultingRevision: 'b'.repeat(64)
    }, {
      songId: 'christ-is-all-ru',
      language: 'ru',
      translationOf: review.family.rootSongId,
      action: 'create',
      resultingRevision: 'c'.repeat(64)
    }],
    unchanged: false,
    recovered: false
  }, review);
  assert.equal(result.members[1].language, 'EN');

  const unsafe = rawReview();
  unsafe.retainedTranslations[0].language = 'Spanish\nLabel';
  assert.throws(
    () => normalizeCurrentServiceSongFamilyReview(unsafe),
    /invalid retained song translation identity language/
  );
});

test('review rejects leaked identity authority and oversized complete evidence', () => {
  const { normalizeCurrentServiceSongFamilyReview } = rendererExports();

  const leakedIdentity = rawReview();
  leakedIdentity.family.members[0].currentIdentity.documentSource =
    '/private/church/song.md';
  assert.throws(
    () => normalizeCurrentServiceSongFamilyReview(leakedIdentity),
    /unsupported PowerPoint song-family current identity details/
  );

  const leakedRetainedPath = rawReview();
  leakedRetainedPath.retainedTranslations[0].sourcePath =
    '/Users/operator/Songs/song.md';
  assert.throws(
    () => normalizeCurrentServiceSongFamilyReview(leakedRetainedPath),
    /unsupported retained song translation identity details/
  );

  const oversizedOccurrence = rawReview();
  oversizedOccurrence.occurrences[0].members[0].lines =
    ['x'.repeat(1_001)];
  assert.throws(
    () => normalizeCurrentServiceSongFamilyReview(oversizedOccurrence),
    /invalid PowerPoint song occurrence complete text line/
  );

  const oversizedTitle = rawReview();
  oversizedTitle.family.members[0].titleCardEvidence.lines =
    Array.from({ length: 33 }, () => 'x'.repeat(1_000));
  assert.throws(
    () => normalizeCurrentServiceSongFamilyReview(oversizedTitle),
    /oversized or empty PowerPoint song-family title-card evidence/
  );

  const oversizedRights = rawReview();
  oversizedRights.family.members[0].metadata.attribution =
    'x'.repeat(2_049);
  assert.throws(
    () => normalizeCurrentServiceSongFamilyReview(oversizedRights),
    /invalid PowerPoint song-family metadata attribution/
  );

  const missingRetainedSet = rawReview();
  delete missingRetainedSet.retainedTranslations;
  assert.throws(
    () => normalizeCurrentServiceSongFamilyReview(missingRetainedSet),
    /unsupported PowerPoint song-family review details/
  );
});

test('repeat defaults require the backend exact-repeat suggestion and every language match', () => {
  const {
    currentServiceSongFamilyDefaultDecisions,
    normalizeCurrentServiceSongFamilyReview
  } = rendererExports();
  const exactReview = normalizeCurrentServiceSongFamilyReview(rawReview());
  assert.deepEqual(
    plain(currentServiceSongFamilyDefaultDecisions(exactReview)),
    [
      {
        occurrenceId: 'occurrence-1',
        action: 'new',
        repeatOfOccurrenceId: null,
        note: ''
      },
      {
        occurrenceId: 'occurrence-2',
        action: 'repeat',
        repeatOfOccurrenceId: 'occurrence-1',
        note: 'Exact in every captured language.'
      }
    ]
  );

  const mismatch = rawReview();
  mismatch.occurrences[1] = occurrence(
    2,
    'Hallelujah! All I have is Christ',
    'Другая строка',
    {
      action: 'repeat',
      repeatOfOccurrenceId: 'occurrence-1',
      note: 'Unsafe stale suggestion.'
    }
  );
  mismatch.occurrences[1].members[0].preview =
    mismatch.occurrences[0].members[0].preview;
  mismatch.occurrences[1].members[1].preview =
    mismatch.occurrences[0].members[1].preview;
  const mismatchReview =
    normalizeCurrentServiceSongFamilyReview(mismatch);
  assert.deepEqual(
    plain(currentServiceSongFamilyDefaultDecisions(mismatchReview)[1]),
    {
      occurrenceId: 'occurrence-2',
      action: 'new',
      repeatOfOccurrenceId: null,
      note: ''
    }
  );
});

test('commit request is exact and requires source and local-only confirmations', () => {
  const {
    currentServiceSongFamilyCommitRequest,
    normalizeCurrentServiceSongFamilyReview
  } = rendererExports();
  const review = normalizeCurrentServiceSongFamilyReview(rawReview());
  const decisions = [
    {
      occurrenceId: 'occurrence-1',
      action: 'new',
      repeatOfOccurrenceId: null,
      note: 'Verse 1'
    },
    {
      occurrenceId: 'occurrence-2',
      action: 'exclude',
      repeatOfOccurrenceId: null,
      note: 'Spoken tag, not congregational lyrics'
    }
  ];
  const metadata = [
    {
      memberKey: 'root',
      license: 'CCLI church license',
      attribution: '',
      tags: ['grace', 'christ'],
      authors: ['Jordan Kauflin'],
      translators: [],
      composers: ['Jordan Kauflin'],
      localServiceRights: {
        basis: 'ccli-service-license',
        evidence: 'CCLI service license and exact SongSelect entry reviewed.'
      }
    },
    {
      memberKey: 'translation',
      license: 'Direct translation permission',
      attribution: 'Russian translation by Local Church',
      tags: ['grace'],
      authors: ['Jordan Kauflin'],
      translators: ['Local Church'],
      composers: ['Jordan Kauflin'],
      localServiceRights: {
        basis: 'direct-permission',
        evidence:
          'Written translation permission reviewed for this local service.'
      }
    }
  ];
  const request = currentServiceSongFamilyCommitRequest({
    review,
    decisions,
    metadata,
    sourceConfirmed: true,
    rightsConfirmed: true,
    localCommitConfirmed: true
  });

  assert.deepEqual(plain(request), {
    reviewToken: 'r'.repeat(32),
    decisions,
    metadata,
    sourceConfirmed: true,
    rightsConfirmed: true,
    localCommitConfirmed: true
  });
  assert.equal(
    /sourcePath|pinnedPath|visibility|community|publication/u
      .test(JSON.stringify(request)),
    false
  );
  for (const missing of [
    'sourceConfirmed',
    'localCommitConfirmed'
  ]) {
    assert.throws(
      () => currentServiceSongFamilyCommitRequest({
        review,
        decisions,
        metadata,
        sourceConfirmed: true,
        rightsConfirmed: true,
        localCommitConfirmed: true,
        [missing]: false
      }),
      /Confirm the exact source and local-only atomic save/
    );
  }
  assert.deepEqual(plain(currentServiceSongFamilyCommitRequest({
    review,
    decisions,
    metadata,
    sourceConfirmed: true,
    rightsConfirmed: false,
    localCommitConfirmed: true
  })), plain(request), 'rights metadata is not a local-save gate');

  const forgedRights = structuredClone(metadata);
  forgedRights[0].localServiceRights.communityVisibility = 'public';
  assert.throws(
    () => currentServiceSongFamilyCommitRequest({
      review,
      decisions,
      metadata: forgedRights,
      sourceConfirmed: true,
      rightsConfirmed: true,
      localCommitConfirmed: true
    }),
    /unsupported local-service song rights selection details/
  );
});

test('commit result and retry rules keep uncertain commits in the local review', () => {
  const {
    currentServiceSongFamilyRetryAction,
    normalizeCurrentServiceSongFamilyCommitResult,
    normalizeCurrentServiceSongFamilyReview
  } = rendererExports();
  const review = normalizeCurrentServiceSongFamilyReview(rawReview());
  const result = normalizeCurrentServiceSongFamilyCommitResult({
    familyId: 'all-i-have-is-christ-en',
    familyRevision: 'f'.repeat(64),
    members: [
      {
        songId: 'all-i-have-is-christ-en',
        language: 'en',
        translationOf: null,
        action: 'update',
        resultingRevision: 'a'.repeat(64)
      },
      {
        songId: 'all-i-have-is-christ-es',
        language: 'es',
        translationOf: 'all-i-have-is-christ-en',
        action: 'reuse',
        resultingRevision: 'c'.repeat(64)
      },
      {
        songId: 'christ-is-all-ru',
        language: 'ru',
        translationOf: 'all-i-have-is-christ-en',
        action: 'create',
        resultingRevision: 'b'.repeat(64)
      }
    ],
    unchanged: false,
    recovered: false
  }, review);
  assert.equal(result.members[1].translationOf, result.familyId);
  assert.equal(
    result.members.find(member => member.songId === 'christ-is-all-ru')
      .language,
    'ru'
  );
  assert.equal(
    currentServiceSongFamilyRetryAction(
      'CURRENT_SERVICE_SONG_FAMILY_COMMIT_IN_PROGRESS'
    ),
    'retry'
  );
  for (const code of [
    'CURRENT_SERVICE_SONG_FAMILY_NOT_READY',
    'CURRENT_SERVICE_SONG_FAMILY_SOURCE_LIMIT',
    'REPEAT_REFERENCE_NOT_PRIOR',
    'REPEAT_REFERENCE_NOT_INCLUDED',
    'REPEAT_TEXT_MISMATCH',
    'CURRENT_SERVICE_SONG_FAMILY_STRUCTURE_MISMATCH',
    'CAPTURE_DOCUMENT_TOO_LARGE'
  ]) {
    assert.equal(
      currentServiceSongFamilyRetryAction(code),
      'edit',
      `${code} should keep Stage 2 editable`
    );
  }
  assert.equal(
    currentServiceSongFamilyRetryAction(
      'CURRENT_SERVICE_SONG_SOURCE_CHANGED'
    ),
    'restart'
  );
  assert.equal(
    currentServiceSongFamilyRetryAction(
      'EXPIRED_CURRENT_SERVICE_SONG_FAMILY_REVIEW'
    ),
    'restart'
  );
  assert.equal(
    currentServiceSongFamilyRetryAction(
      'CURRENT_SERVICE_SONG_ROLE_UNAVAILABLE'
    ),
    'restart'
  );
  assert.equal(
    currentServiceSongFamilyRetryAction(
      'CURRENT_SERVICE_SONG_FAMILY_RESULT_INVALID'
    ),
    'restart'
  );
  for (const code of [
    'CURRENT_SERVICE_SONG_FAMILY_MEMBER_LIMIT',
    'CURRENT_SERVICE_SONG_FAMILY_TOO_LARGE',
    'INVALID_REVIEW_SNAPSHOT',
    'SNAPSHOT_TOO_LARGE',
    'SONG_FAMILY_CONFLICT',
    'FAMILY_COMMIT_CONFLICT',
    'CURRENT_SERVICE_SONG_FAMILY_RETRY_MISMATCH'
  ]) {
    assert.equal(
      currentServiceSongFamilyRetryAction(code),
      'restart',
      `${code} should require a fresh family review`
    );
  }
});

test('main-style family errors preserve codes and drive editable or restart state', () => {
  const {
    checkedResult,
    currentServiceSongFamilyFailureState
  } = rendererExports();
  let editableError = null;
  assert.throws(
    () => checkedResult({
      success: false,
      error: {
        code: 'REPEAT_TEXT_MISMATCH',
        message: 'That repeat differs in one captured language.'
      }
    }),
    error => {
      editableError = error;
      return error.code === 'REPEAT_TEXT_MISMATCH'
        && error.message
          === 'That repeat differs in one captured language.';
    }
  );
  assert.deepEqual(
    plain(currentServiceSongFamilyFailureState(editableError)),
    {
      retryAction: 'edit',
      keepPendingRequest: false,
      stageTwoEditable: true,
      mustRestart: false
    }
  );

  let staleError = null;
  assert.throws(
    () => checkedResult({
      success: false,
      error: {
        code: 'CURRENT_SERVICE_SONG_SOURCE_CHANGED',
        message: 'The reviewed PowerPoint bytes changed.'
      }
    }),
    error => {
      staleError = error;
      return error.code === 'CURRENT_SERVICE_SONG_SOURCE_CHANGED'
        && error.message === 'The reviewed PowerPoint bytes changed.';
    }
  );
  assert.deepEqual(
    plain(currentServiceSongFamilyFailureState(staleError)),
    {
      retryAction: 'restart',
      keepPendingRequest: false,
      stageTwoEditable: false,
      mustRestart: true
    }
  );
});

test('song form submission dispatches to the active workflow stage', () => {
  const { currentServiceSongFormSubmitAction } = rendererExports();

  assert.equal(
    currentServiceSongFormSubmitAction({
      familyAvailable: false,
      familyStage: 'capture'
    }),
    'build-draft'
  );
  assert.equal(
    currentServiceSongFormSubmitAction({
      familyAvailable: true,
      familyStage: 'capture'
    }),
    'begin-family-review'
  );
  assert.equal(
    currentServiceSongFormSubmitAction({
      familyAvailable: true,
      familyStage: 'review'
    }),
    'commit-family'
  );
  assert.match(
    controllerSource,
    /currentServiceSongForm\.addEventListener\(\s*'submit',\s*submitCurrentServiceSongForm\s*\)/
  );
  assert.match(
    controllerSource,
    /if \(action === 'commit-family'\) \{[\s\S]*btnCommitCurrentServiceSongFamily\.disabled[\s\S]*commitCurrentServiceSongFamilyReview\(\)[\s\S]*return;[\s\S]*if \(action === 'begin-family-review'\) \{[\s\S]*beginCurrentServiceSongFamilyReview\(\)/
  );
});

test('capture and song-detail changes invalidate the matching review state', () => {
  assert.match(
    controllerSource,
    /laneSelect\.addEventListener\('change', \(\) => \{[\s\S]*state\.currentServiceSongReviewDirty = true;[\s\S]*currentServiceSongConfirmed\.checked = false;/
  );
  assert.match(controllerSource, /rightsBasis\.value = 'church-managed'/);
  assert.match(
    controllerSource,
    /function invalidateCurrentServiceSongFamilyFinalReview\(\) \{[\s\S]*state\.currentServiceSongReviewDirty = true;[\s\S]*currentServiceSongFamilySourceConfirmed\.checked = false;[\s\S]*currentServiceSongFamilyRightsConfirmed\.checked = false;[\s\S]*currentServiceSongFamilyLocalConfirmed\.checked = false;[\s\S]*renderCurrentServiceSongFamilyReviewState\(\);/
  );
});

test('member switcher and saved identity copy use accurate semantics', () => {
  assert.match(
    htmlSource,
    /id="currentServiceSongMemberTabs"[^>]*role="group"[^>]*aria-label="Song-family members"/
  );
  assert.doesNotMatch(
    htmlSource,
    /id="currentServiceSongMemberTabs"[^>]*role="tablist"/
  );
  assert.match(
    controllerSource,
    /button\.setAttribute\(\s*'aria-pressed'/
  );
  assert.doesNotMatch(
    controllerSource,
    /button\.role = 'tab'/
  );
  assert.match(
    stylesSource,
    /\.prepare-current-service-song-member-tab\[aria-pressed="true"\]/
  );
  assert.match(
    controllerSource,
    /Saved Song Library license metadata/
  );
  assert.match(
    controllerSource,
    /No saved Song Library license or credit metadata\./
  );
});

test('dialog exposes the complete volunteer review and only local commit controls', () => {
  for (const id of [
    'currentServiceSongMemberTabs',
    'btnAddCurrentServiceSongTranslation',
    'btnRemoveCurrentServiceSongTranslation',
    'currentServiceSongId',
    'currentServiceSongFamilyReviewStage',
    'currentServiceSongFamilyIdentitySummary',
    'currentServiceSongFamilyOccurrences',
    'currentServiceSongFamilyMetadata',
    'currentServiceSongFamilySourceConfirmed',
    'currentServiceSongFamilyRightsConfirmed',
    'currentServiceSongFamilyLocalConfirmed',
    'currentServiceSongFamilyLocalConfirmedLabel',
    'btnCommitCurrentServiceSongFamily'
  ]) {
    assert.match(htmlSource, new RegExp(`id="${id}"`));
  }
  assert.match(htmlSource, /same or a different service presentation/);
  assert.match(htmlSource, /new, repeat, or exclude/);
  assert.match(htmlSource, /LOCAL Song Library/);
  assert.match(htmlSource, /does not publish or share anything with Community/);
  assert.match(htmlSource, /SOURCE &amp; CREDITS/);
  assert.match(controllerSource, /COMPLETE CAPTURED LANE TEXT/);
  assert.match(controllerSource, /BOUND TITLE-CARD EVIDENCE/);
  assert.match(controllerSource, /NO TITLE-CARD EVIDENCE BOUND/);
  assert.match(controllerSource, /CREATE NEW/);
  assert.match(controllerSource, /EXISTING — MAY UPDATE/);
  assert.match(controllerSource, /RETAIN UNCHANGED/);
  assert.match(controllerSource, /rightsBasis\.value = 'church-managed'/);
  assert.doesNotMatch(htmlSource, /A CCLI\/SongSelect number alone is not permission/);
  assert.match(controllerSource, /may replace the current saved revision/);
  assert.match(controllerSource, /will be retained unchanged/);
  assert.match(
    stylesSource,
    /\.prepare-current-service-song-occurrences/
  );
  assert.match(
    stylesSource,
    /\.prepare-current-service-song-identities/
  );
  assert.match(
    stylesSource,
    /\.prepare-current-service-song-title-card-evidence/
  );
  assert.match(
    controllerSource,
    /api\.beginCurrentServiceSongFamilyReview\(request\)/
  );
  assert.match(
    controllerSource,
    /api\.commitCurrentServiceSongFamilyReview\(request\)/
  );
  assert.match(
    controllerSource,
    /state\.currentServiceSongFamilyCommitBusy = true;[\s\S]*state\.currentServiceSongFamilyCommitBusy = false;/
  );
  assert.match(
    controllerSource,
    /currentServiceSongFamilyFailureState\(error\)[\s\S]*currentServiceSongFamilyCommitMustRestart =\s*failureState\.mustRestart/
  );
  assert.match(
    controllerSource,
    /request =\s*state\.currentServiceSongFamilyPendingCommitRequest\s*\|\| currentServiceSongFamilyCommitDraft\(\)/
  );
  assert.match(
    controllerSource,
    /state\.currentServiceSongFamilyPendingCommitRequest = request;/
  );
  assert.match(
    controllerSource,
    /if \(!failureState\.keepPendingRequest\) \{[\s\S]*currentServiceSongFamilyPendingCommitRequest = null;[\s\S]*currentServiceSongFamilyLocalConfirmed\.checked = false;/
  );
  assert.match(
    controllerSource,
    /btnBackToCurrentServiceSongCapture\.disabled =\s*busy \|\| exactRetryPending/
  );
  const refreshStart = controllerSource.indexOf(
    'async function refreshCurrentServiceSongFamilyCaptures()'
  );
  const refreshEnd = controllerSource.indexOf(
    'function currentServiceSongFamilyReviewMatchesRequest',
    refreshStart
  );
  const refreshSource = controllerSource.slice(refreshStart, refreshEnd);
  assert.match(
    refreshSource,
    /for \(const capture of captures\) \{[\s\S]*sourcesByRole\.has\(capture\.roleId\)[\s\S]*await loadCurrentServiceCompanion\(\)[\s\S]*inspectCurrentServiceSongSource\(\{[\s\S]*inspectionToken,[\s\S]*roleId: capture\.roleId/
  );
});
