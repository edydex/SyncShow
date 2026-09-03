'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SERMON_SCHEMA_VERSION,
  SermonReadingPlanError,
  planSermonPrimaryReading
} = require('../src/services/project');

function sermon(references) {
  return {
    schemaVersion: SERMON_SCHEMA_VERSION,
    kind: 'syncshow-sermon',
    id: 'sermon-reading-plan',
    titles: { en: 'A Reviewed Sermon' },
    defaultLanguage: 'en',
    speaker: { id: null, name: 'Pastor' },
    serviceDate: '2026-07-27',
    series: null,
    outline: [],
    sources: [],
    references,
    media: [],
    publication: {
      status: 'draft',
      visibility: 'private',
      publishedAt: null,
      canonicalUrl: null
    }
  };
}

function reference(id, range, overrides = {}) {
  return {
    id,
    range: {
      schemaVersion: 1,
      bookId: 'Eph',
      start: { chapter: 3, verse: 1 },
      end: { chapter: 3, verse: 18 },
      ...range
    },
    role: 'primary',
    source: 'operator',
    reviewStatus: 'confirmed',
    enteredText: 'Ephesians 3:1-18',
    sourceId: null,
    sectionId: null,
    startOffset: null,
    endOffset: null,
    ...overrides
  };
}

test('sermon reading plan splits an exact reviewed range without gaps or overlap', () => {
  const plan = planSermonPrimaryReading(
    sermon([reference('primary')]),
    { maxVerses: 8 }
  );

  assert.equal(plan.sermonId, 'sermon-reading-plan');
  assert.equal(plan.referenceId, 'primary');
  assert.equal(plan.reference, 'Ephesians 3:1-18');
  assert.deepEqual(plan.chunks, [
    {
      reference: 'Ephesians 3:1-8',
      range: {
        schemaVersion: 1,
        bookId: 'Eph',
        start: { chapter: 3, verse: 1 },
        end: { chapter: 3, verse: 8 }
      }
    },
    {
      reference: 'Ephesians 3:9-16',
      range: {
        schemaVersion: 1,
        bookId: 'Eph',
        start: { chapter: 3, verse: 9 },
        end: { chapter: 3, verse: 16 }
      }
    },
    {
      reference: 'Ephesians 3:17-18',
      range: {
        schemaVersion: 1,
        bookId: 'Eph',
        start: { chapter: 3, verse: 17 },
        end: { chapter: 3, verse: 18 }
      }
    }
  ]);
});

test('sermon reading plan requires an explicit choice when several primaries are confirmed', () => {
  const document = sermon([
    reference('first'),
    reference('second', {
      start: { chapter: 4, verse: 1 },
      end: { chapter: 4, verse: 3 }
    })
  ]);

  assert.throws(
    () => planSermonPrimaryReading(document),
    error => error instanceof SermonReadingPlanError
      && error.code === 'SERMON_PRIMARY_READING_SELECTION_REQUIRED'
  );
  const selected = planSermonPrimaryReading(document, {
    referenceId: 'second',
    maxVerses: 8
  });
  assert.equal(selected.referenceId, 'second');
  assert.equal(selected.reference, 'Ephesians 4:1-3');
});

test('sermon reading plan never promotes mentioned, suggested, or cross-chapter references', () => {
  assert.throws(
    () => planSermonPrimaryReading(sermon([
      reference('mentioned', undefined, { role: 'mentioned' }),
      reference('suggested', undefined, { reviewStatus: 'suggested' })
    ])),
    error => error instanceof SermonReadingPlanError
      && error.code === 'SERMON_PRIMARY_READING_UNAVAILABLE'
  );

  assert.throws(
    () => planSermonPrimaryReading(sermon([
      reference('cross-chapter', {
        start: { chapter: 3, verse: 20 },
        end: { chapter: 4, verse: 2 }
      })
    ])),
    error => error instanceof SermonReadingPlanError
      && error.code === 'SERMON_PRIMARY_READING_RANGE_UNSUPPORTED'
  );
});
