'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SONG_FAMILY_CAPTURE_KIND,
  SongFamilyCaptureReviewError,
  applySongFamilyCaptureReview,
  createSongFamilyCaptureReview
} = require('../src/services/project/SongFamilyCaptureReview');
const {
  compareSongSections,
  normalizeSongDocument
} = require('../src/services/project/SongDocument');

const JULY_26_DECK_SHA256 =
  '51171e6a2f94f04d512574b318d86c110d6bf75868b89fa900bbcb274ef57973';

const P1 = Object.freeze({
  ru: Object.freeze([
    'Иисус, мой Спаситель,',
    'Нет никого как Ты!',
    'Все мои дни, буду хвалить я',
    'Чудеса Твоей любви.'
  ]),
  en: Object.freeze([
    'My Jesus, my Savior,',
    'Lord there is none like you.',
    'All of my days, I want to praise',
    'The wonders of Your mighty love.'
  ])
});

const P2 = Object.freeze({
  ru: Object.freeze([
    'Покой мой, приют мой,',
    'Сила спасения в Тебе.',
    'Каждый мой вздох будет всегда',
    'Славу возносить Тебе!'
  ]),
  en: Object.freeze([
    'My comfort, my shelter',
    'Tower of refuge and strength',
    'Let every breath, all that I am',
    'Never cease to worship You'
  ])
});

const P3 = Object.freeze({
  ru: Object.freeze([
    'Громко воскликну я Богу хвалу!',
    'Сила, величие и слава Царю!',
    'Горы склоняться, моря восшумят',
    'Имя Бога вознося!'
  ]),
  en: Object.freeze([
    'Shout to the Lord, all the earth let us sing.',
    'Power and majesty, praise to the King!',
    'Mountains bow down and the seas will roar',
    'At the sound of your name!'
  ])
});

const P4 = Object.freeze({
  ru: Object.freeze([
    'В радости песню хвалы я пою.',
    'Знают пусть все, как Тебя я люблю.',
    'Нет ничего, что могло бы сравниться',
    'С Тобой!'
  ]),
  en: Object.freeze([
    'I’ll sing for joy at the work of your hands,',
    "Forever I'll love you, forever I'll stand.",
    'Nothing compares to the promise',
    'I have in You!'
  ])
});

const P5 = Object.freeze({
  ru: Object.freeze([
    'В радости песню хвалы я пою.',
    'Знают пусть все, как Тебя я люблю.',
    'Нет ничего, что могло бы сравниться…'
  ]),
  en: Object.freeze([
    'I’ll sing for joy at the work of your hands,',
    "Forever I'll love you, forever I'll stand.",
    'Nothing compares to the promise I have…'
  ])
});

const P6 = Object.freeze({
  ru: Object.freeze([
    'В радости песню хвалы я пою.',
    'Знают пусть все, как Тебя я люблю.',
    'Нет ничего, что могло бы сравниться c Тобой!'
  ]),
  en: Object.freeze([
    'I’ll sing for joy at the work of your hands,',
    "Forever I'll love you, forever I'll stand.",
    'Nothing compares to the promise I have,',
    'Nothing compares to the promise I have,',
    'Nothing compares to the promise I have in You!'
  ])
});

const JULY_26_OCCURRENCES = Object.freeze([
  Object.freeze({ slide: 12, lanes: 'RU white; EN yellow', lines: P1 }),
  Object.freeze({ slide: 13, lanes: 'RU white; EN yellow', lines: P2 }),
  Object.freeze({ slide: 14, lanes: 'RU white; EN yellow', lines: P3 }),
  Object.freeze({ slide: 15, lanes: 'RU white; EN yellow', lines: P4 }),
  Object.freeze({ slide: 16, lanes: 'RU yellow; EN white', lines: P1 }),
  Object.freeze({ slide: 17, lanes: 'RU yellow; EN white', lines: P2 }),
  Object.freeze({ slide: 18, lanes: 'RU yellow; EN white', lines: P3 }),
  Object.freeze({ slide: 19, lanes: 'RU yellow; EN white', lines: P5 }),
  Object.freeze({ slide: 20, lanes: 'RU yellow; EN white', lines: P3 }),
  Object.freeze({ slide: 21, lanes: 'RU yellow; EN white', lines: P6 })
]);

function july26Capture() {
  return {
    schemaVersion: 1,
    kind: SONG_FAMILY_CAPTURE_KIND,
    source: {
      label: '07-26-2026 Service ENG.pptx slides 12-21',
      sha256: JULY_26_DECK_SHA256
    },
    documents: [
      {
        key: 'ru',
        id: 'iisus-moi-spasitel',
        title: 'Иисус, мой Спаситель',
        language: 'ru'
      },
      {
        key: 'en',
        id: 'my-jesus-my-savior',
        title: 'My Jesus, My Savior',
        language: 'en'
      }
    ],
    occurrences: JULY_26_OCCURRENCES.map(({ slide, lanes, lines }) => ({
      occurrenceId: `slide-${slide}`,
      sourceLabel: `PowerPoint slide ${slide}; ${lanes}`,
      linesByDocument: {
        ru: [...lines.ru],
        en: [...lines.en]
      }
    }))
  };
}

function reviewWithActions(review, actionsByOccurrenceId) {
  return {
    ...review,
    decisions: review.decisions.map(decision => {
      const action = actionsByOccurrenceId[decision.occurrenceId];
      if (!action) return { ...decision };
      return {
        ...decision,
        action: action.action,
        repeatOfOccurrenceId: action.repeatOfOccurrenceId ?? null,
        note: action.note || ''
      };
    })
  };
}

function expectReviewCode(fn, code) {
  assert.throws(
    fn,
    error => error instanceof SongFamilyCaptureReviewError
      && error.code === code
  );
}

test('safe default preserves every paired July 26 occurrence as a new provisional section', () => {
  const capture = july26Capture();
  const review = createSongFamilyCaptureReview(capture, {
    rootDocumentKey: 'en'
  });

  assert.deepEqual(
    review.decisions.map(decision => decision.action),
    Array(10).fill('new')
  );

  const result = applySongFamilyCaptureReview(capture, review);
  assert.equal(result.status, 'ready');
  assert.deepEqual(
    result.occurrenceArrangement.map(entry => entry.id),
    Array.from({ length: 10 }, (_, index) => `slide-${index + 12}`)
  );
  assert.deepEqual(
    result.occurrenceArrangement.map(entry => entry.sectionId),
    Array.from({ length: 10 }, (_, index) => `p${index + 1}`)
  );
  assert.equal(result.documents.length, 2);
  assert.equal(result.documents[0].sections.length, 10);
  assert.equal(result.documents[1].sections.length, 10);
  assert.deepEqual(result.captureSource, {
    label: '07-26-2026 Service ENG.pptx slides 12-21',
    sha256: JULY_26_DECK_SHA256
  });
  assert.deepEqual(result.reviewBoundaries, {
    rightsReviewed: false,
    communityVisibilityReviewed: false
  });
  assert.ok(result.documents.every(document => document.license === ''));
});

test('explicit exact repeats produce compatible canonical documents and the reviewed July arrangement', () => {
  const capture = july26Capture();
  const defaultReview = createSongFamilyCaptureReview(capture, {
    rootDocumentKey: 'en'
  });
  const review = reviewWithActions(defaultReview, {
    'slide-16': { action: 'repeat', repeatOfOccurrenceId: 'slide-12' },
    'slide-17': { action: 'repeat', repeatOfOccurrenceId: 'slide-13' },
    'slide-18': { action: 'repeat', repeatOfOccurrenceId: 'slide-14' },
    'slide-20': { action: 'repeat', repeatOfOccurrenceId: 'slide-14' }
  });

  const result = applySongFamilyCaptureReview(capture, review);
  const russian = result.documents.find(document => document.language === 'ru');
  const english = result.documents.find(document => document.language === 'en');

  assert.equal(result.status, 'ready');
  assert.deepEqual(
    result.occurrenceArrangement.map(entry => entry.sectionId),
    ['p1', 'p2', 'p3', 'p4', 'p1', 'p2', 'p3', 'p5', 'p3', 'p6']
  );
  const markerBySectionId = new Map(
    english.sections.map(section => [section.id, section.marker])
  );
  assert.deepEqual(
    result.occurrenceArrangement.map(entry =>
      markerBySectionId.get(entry.sectionId)),
    ['P1', 'P2', 'P3', 'P4', 'P1', 'P2', 'P3', 'P5', 'P3', 'P6']
  );
  assert.equal(english.translationOf, null);
  assert.equal(russian.translationOf, english.id);
  assert.deepEqual(result.documentRoles, [
    {
      documentKey: 'ru',
      role: 'translation',
      translationOfDocumentKey: 'en'
    },
    {
      documentKey: 'en',
      role: 'root',
      translationOfDocumentKey: null
    }
  ]);
  assert.deepEqual(compareSongSections(english, russian), {
    compatible: true,
    missingSectionIds: [],
    extraSectionIds: [],
    slideMismatches: []
  });
  assert.deepEqual(normalizeSongDocument(english), english);
  assert.deepEqual(normalizeSongDocument(russian), russian);

  assert.deepEqual(english.sections[3].slides[0].lines, P4.en);
  assert.deepEqual(english.sections[4].slides[0].lines, P5.en);
  assert.deepEqual(english.sections[5].slides[0].lines, P6.en);
  assert.deepEqual(russian.sections[3].slides[0].lines, P4.ru);
  assert.deepEqual(russian.sections[4].slides[0].lines, P5.ru);
  assert.deepEqual(russian.sections[5].slides[0].lines, P6.ru);
  assert.notDeepEqual(
    english.sections[3].slides[0].lines,
    english.sections[4].slides[0].lines
  );
  assert.notDeepEqual(
    english.sections[4].slides[0].lines,
    english.sections[5].slides[0].lines
  );
  assert.notDeepEqual(
    russian.sections[3].slides[0].lines,
    russian.sections[4].slides[0].lines
  );
  assert.notDeepEqual(
    russian.sections[4].slides[0].lines,
    russian.sections[5].slides[0].lines
  );
  assert.deepEqual(
    result.decisionEvidence
      .filter(evidence => evidence.action === 'repeat')
      .map(evidence => [
        evidence.occurrenceId,
        evidence.repeatOfOccurrenceId,
        evidence.exactRepeat
      ]),
    [
      ['slide-16', 'slide-12', true],
      ['slide-17', 'slide-13', true],
      ['slide-18', 'slide-14', true],
      ['slide-20', 'slide-14', true]
    ]
  );
});

test('repeat rejects one-sided equality and punctuation, case, or line-break near matches', async t => {
  const mutations = [
    {
      name: 'punctuation differs on English side',
      documentKey: 'en',
      lines: [
        ...P1.en.slice(0, -1),
        'The wonders of Your mighty love!'
      ]
    },
    {
      name: 'case differs on English side',
      documentKey: 'en',
      lines: [
        ...P1.en.slice(0, -1),
        'The wonders of your mighty love.'
      ]
    },
    {
      name: 'same English words are reflowed',
      documentKey: 'en',
      lines: [
        'My Jesus, my Savior, Lord there is none like you.',
        'All of my days, I want to praise',
        'The wonders of Your mighty love.'
      ]
    },
    {
      name: 'punctuation differs on Russian side while English is exact',
      documentKey: 'ru',
      lines: [
        ...P1.ru.slice(0, -1),
        'Чудеса Твоей любви!'
      ]
    }
  ];

  for (const mutation of mutations) {
    await t.test(mutation.name, () => {
      const capture = july26Capture();
      capture.occurrences = capture.occurrences.slice(0, 2);
      capture.occurrences[1] = {
        occurrenceId: 'slide-16',
        sourceLabel: 'PowerPoint slide 16; RU yellow; EN white',
        linesByDocument: {
          ru: [...P1.ru],
          en: [...P1.en],
          [mutation.documentKey]: mutation.lines
        }
      };
      const defaultReview = createSongFamilyCaptureReview(capture, {
        rootDocumentKey: 'en'
      });
      const review = reviewWithActions(defaultReview, {
        'slide-16': {
          action: 'repeat',
          repeatOfOccurrenceId: 'slide-12'
        }
      });

      assert.throws(
        () => applySongFamilyCaptureReview(capture, review),
        error => {
          assert.ok(error instanceof SongFamilyCaptureReviewError);
          assert.equal(error.code, 'REPEAT_TEXT_MISMATCH');
          assert.deepEqual(
            error.details.mismatchedDocumentKeys,
            [mutation.documentKey]
          );
          return true;
        }
      );
    });
  }
});

test('unresolved and excluded nonempty captures retain their complete decision evidence', () => {
  const capture = july26Capture();
  capture.occurrences = capture.occurrences.slice(0, 2);
  capture.occurrences[1] = {
    occurrenceId: 'slide-13',
    sourceLabel: 'PowerPoint slide 13; RU white; English lane missing',
    linesByDocument: {
      ru: [...P2.ru]
    }
  };
  const defaultReview = createSongFamilyCaptureReview(capture, {
    rootDocumentKey: 'en'
  });

  assert.deepEqual(
    defaultReview.decisions.map(decision => decision.action),
    ['new', 'needs-pairing']
  );
  const unresolved = applySongFamilyCaptureReview(capture, defaultReview);
  assert.equal(unresolved.status, 'needs-review');
  assert.deepEqual(unresolved.documents, []);
  assert.deepEqual(unresolved.occurrenceArrangement, []);
  assert.equal(unresolved.unresolvedEvidence.length, 1);
  assert.deepEqual(
    unresolved.unresolvedEvidence[0].linesByDocument,
    { ru: [...P2.ru] }
  );
  assert.equal(unresolved.unresolvedEvidence[0].sourceLabel,
    'PowerPoint slide 13; RU white; English lane missing');

  const excludedReview = reviewWithActions(defaultReview, {
    'slide-13': {
      action: 'exclude',
      note: 'Operator confirmed this was not part of the song family.'
    }
  });
  const excluded = applySongFamilyCaptureReview(capture, excludedReview);
  assert.equal(excluded.status, 'ready');
  assert.equal(excluded.documents.length, 2);
  assert.deepEqual(excluded.occurrenceArrangement, [
    { id: 'slide-12', sectionId: 'p1' }
  ]);
  assert.equal(excluded.excludedEvidence.length, 1);
  assert.deepEqual(
    excluded.excludedEvidence[0].linesByDocument,
    { ru: [...P2.ru] }
  );
  assert.equal(
    excluded.excludedEvidence[0].note,
    'Operator confirmed this was not part of the song family.'
  );
});

test('monolingual capture creates one standalone document without inventing a translation', () => {
  const capture = {
    schemaVersion: 1,
    kind: SONG_FAMILY_CAPTURE_KIND,
    source: {
      label: 'Reviewed monolingual slide capture',
      sha256: ''
    },
    documents: [{
      key: 'en',
      id: 'standalone-song',
      title: 'Standalone Song',
      language: 'en'
    }],
    occurrences: [{
      occurrenceId: 'slide-1',
      sourceLabel: 'PowerPoint slide 1; white lane',
      linesByDocument: {
        en: ['A standalone lyric', 'with no invented partner']
      }
    }]
  };
  const review = createSongFamilyCaptureReview(capture, {
    rootDocumentKey: 'en'
  });
  const result = applySongFamilyCaptureReview(capture, review);

  assert.equal(result.status, 'ready');
  assert.equal(result.documents.length, 1);
  assert.equal(result.documents[0].translationOf, null);
  assert.deepEqual(result.documentRoles, [{
    documentKey: 'en',
    role: 'root',
    translationOfDocumentKey: null
  }]);
  assert.deepEqual(result.documents[0].sections[0].slides[0].lines, [
    'A standalone lyric',
    'with no invented partner'
  ]);
});

test('bilingual review requires an explicit valid root document', () => {
  const capture = july26Capture();

  expectReviewCode(
    () => createSongFamilyCaptureReview(capture, {
      rootDocumentKey: ''
    }),
    'MISSING_ROOT_DOCUMENT'
  );
  expectReviewCode(
    () => createSongFamilyCaptureReview(capture, {
      rootDocumentKey: 'uk'
    }),
    'UNKNOWN_ROOT_DOCUMENT'
  );
});

test('ready result rejects a capture that cannot fit canonical SongDocument bytes', () => {
  const capture = {
    schemaVersion: 1,
    kind: SONG_FAMILY_CAPTURE_KIND,
    source: {
      label: 'Oversized reviewed capture',
      sha256: ''
    },
    documents: [{
      key: 'en',
      id: 'oversized-song',
      title: 'Oversized Song',
      language: 'en'
    }],
    occurrences: [{
      occurrenceId: 'slide-1',
      sourceLabel: 'Oversized synthetic slide',
      linesByDocument: {
        en: Array.from(
          { length: 600 },
          (_, index) => `${String(index).padStart(4, '0')}${'x'.repeat(996)}`
        )
      }
    }]
  };
  const review = createSongFamilyCaptureReview(capture, {
    rootDocumentKey: 'en'
  });

  expectReviewCode(
    () => applySongFamilyCaptureReview(capture, review),
    'CAPTURE_DOCUMENT_TOO_LARGE'
  );
});
