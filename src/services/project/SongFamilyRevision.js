'use strict';

const crypto = require('crypto');

const REVISION_PATTERN = /^[a-f0-9]{64}$/;
const SONG_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_FAMILY_DOCUMENTS = 32;

function compareCanonicalText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalFamilyDocuments(value) {
  const documents = Array.isArray(value) ? value : value?.documents;
  if (
    !Array.isArray(documents)
    || documents.length < 1
    || documents.length > MAX_FAMILY_DOCUMENTS
  ) {
    throw new TypeError(
      `A song family must contain between one and ${MAX_FAMILY_DOCUMENTS} exact documents.`
    );
  }
  const seen = new Set();
  const normalized = documents.map(document => {
    const id = document?.song?.id;
    const revision = document?.revision;
    const translationOf = document?.song?.translationOf || null;
    if (
      typeof id !== 'string'
      || !SONG_ID_PATTERN.test(id)
      || typeof revision !== 'string'
      || !REVISION_PATTERN.test(revision)
      || seen.has(id)
    ) {
      throw new TypeError(
        'A song family contains an invalid or duplicate exact document.'
      );
    }
    seen.add(id);
    return { id, revision, translationOf };
  });
  normalized.sort((left, right) =>
    Number(Boolean(left.translationOf))
      - Number(Boolean(right.translationOf))
    || compareCanonicalText(left.id, right.id));
  return normalized;
}

function songFamilyRevision(value) {
  const documents = canonicalFamilyDocuments(value);
  return crypto.createHash('sha256')
    .update(documents
      .map(document => `${document.id}:${document.revision}`)
      .join('\n'))
    .digest('hex');
}

module.exports = {
  MAX_FAMILY_DOCUMENTS,
  canonicalFamilyDocuments,
  compareCanonicalText,
  songFamilyRevision
};
