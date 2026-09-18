'use strict';

const {
  formatBibleRange,
  normalizeBibleRange
} = require('./BibleRange');
const { normalizeSermonDocument } = require('./SermonDocument');

const DEFAULT_SERMON_READING_MAX_VERSES = 8;
const ABSOLUTE_SERMON_READING_MAX_VERSES = 100;

class SermonReadingPlanError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SermonReadingPlanError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new SermonReadingPlanError(code, message, details);
}

function normalizedMaximum(value) {
  const maximum = value ?? DEFAULT_SERMON_READING_MAX_VERSES;
  if (
    !Number.isSafeInteger(maximum)
    || maximum < 1
    || maximum > ABSOLUTE_SERMON_READING_MAX_VERSES
  ) {
    throw new TypeError(
      `Sermon reading cue size must be an integer from 1 through ${ABSOLUTE_SERMON_READING_MAX_VERSES}.`
    );
  }
  return maximum;
}

function confirmedPrimaryReferences(document) {
  return document.references.filter(reference =>
    reference.role === 'primary' && reference.reviewStatus === 'confirmed');
}

function selectPrimaryReference(document, referenceId) {
  const candidates = confirmedPrimaryReferences(document);
  if (candidates.length < 1) {
    fail(
      'SERMON_PRIMARY_READING_UNAVAILABLE',
      'The linked sermon revision has no confirmed primary passage to add.'
    );
  }

  if (referenceId !== undefined && referenceId !== null && referenceId !== '') {
    const selected = candidates.find(reference => reference.id === referenceId);
    if (!selected) {
      fail(
        'SERMON_PRIMARY_READING_NOT_FOUND',
        'Choose a confirmed primary passage from the linked sermon revision.',
        { referenceId }
      );
    }
    return selected;
  }

  if (candidates.length > 1) {
    fail(
      'SERMON_PRIMARY_READING_SELECTION_REQUIRED',
      'Choose which confirmed primary passage should be added to the service.',
      { referenceIds: candidates.map(reference => reference.id) }
    );
  }
  return candidates[0];
}

/**
 * Turn one reviewed primary sermon range into bounded, consecutive projected
 * cues. The plan contains only canonical ranges and labels; translation text
 * remains a trusted application-layer lookup so the renderer cannot supply or
 * alter Scripture wording.
 */
function planSermonPrimaryReading(rawSermon, options = {}) {
  const document = normalizeSermonDocument(rawSermon);
  const maximum = normalizedMaximum(options.maxVerses);
  const selected = selectPrimaryReference(document, options.referenceId);
  const range = normalizeBibleRange(selected.range);

  if (
    range.start.verse === null
    || range.end.verse === null
    || range.start.chapter !== range.end.chapter
  ) {
    fail(
      'SERMON_PRIMARY_READING_RANGE_UNSUPPORTED',
      'The primary reading must be a verse range within one chapter before it can be projected.',
      { referenceId: selected.id, range }
    );
  }

  const chunks = [];
  for (
    let verseStart = range.start.verse;
    verseStart <= range.end.verse;
    verseStart += maximum
  ) {
    const chunkRange = {
      schemaVersion: range.schemaVersion,
      bookId: range.bookId,
      start: {
        chapter: range.start.chapter,
        verse: verseStart
      },
      end: {
        chapter: range.end.chapter,
        verse: Math.min(verseStart + maximum - 1, range.end.verse)
      }
    };
    chunks.push({
      range: chunkRange,
      reference: formatBibleRange(chunkRange)
    });
  }

  return {
    sermonId: document.id,
    referenceId: selected.id,
    reference: formatBibleRange(range),
    enteredText: selected.enteredText,
    chunks
  };
}

module.exports = {
  ABSOLUTE_SERMON_READING_MAX_VERSES,
  DEFAULT_SERMON_READING_MAX_VERSES,
  SermonReadingPlanError,
  planSermonPrimaryReading
};
