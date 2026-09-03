'use strict';

const crypto = require('crypto');

const {
  addSongResource,
  compareSongTranslations,
  compileServiceProject,
  normalizeServiceProject,
  replaceProjectItemRange,
  serializeServiceProject
} = require('./ServiceProject');
const {
  MAX_SOURCE_BYTES,
  parseSongDocument,
  serializeSongDocument
} = require('./SongDocument');
const {
  songFamilyRevision
} = require('./SongFamilyRevision');
const {
  SONG_FAMILY_REVIEW_CONFIRMATION_AUTHORITY_SCOPE,
  SONG_FAMILY_REVIEW_RECEIPT_KIND,
  SONG_FAMILY_REVIEW_RECEIPT_SCHEMA_VERSION,
  SONG_FAMILY_REVIEW_SCOPE,
  SONG_FAMILY_REVIEW_SNAPSHOT_KIND,
  SONG_FAMILY_REVIEW_SNAPSHOT_SCHEMA_VERSION
} = require('./LocalSongFamilyReviewStore');

const REVIEWED_SONG_RANGE_REPLACEMENT_SCHEMA_VERSION = 1;
const REVIEWED_SONG_RANGE_REPLACEMENT_KIND =
  'syncshow-reviewed-song-range-replacement-proposal';
const SOURCE_RANGE_REPLACEMENT_SCHEMA_VERSION = 1;
const SOURCE_RANGE_REPLACEMENT_KIND = 'reviewed-powerpoint-song-range';
const MAX_SOURCE_RANGE_ITEMS = 200;
const MAX_CHANNEL_MAPPINGS = 32;
const MAX_FAMILY_RESOURCES = 32;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

class ReviewedSongRangeReplacementError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ReviewedSongRangeReplacementError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function fail(code, message, details = {}) {
  throw new ReviewedSongRangeReplacementError(code, message, details);
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(raw, requiredKeys, optionalKeys, field, code) {
  if (!isRecord(raw)) {
    fail(code, `${field} must be an object.`, { field });
  }
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  const missing = requiredKeys.filter(key =>
    !Object.prototype.hasOwnProperty.call(raw, key));
  const unexpected = Object.keys(raw).filter(key => !allowed.has(key));
  if (missing.length > 0 || unexpected.length > 0) {
    fail(code, `${field} has unsupported or missing fields.`, {
      field,
      missing,
      unexpected
    });
  }
}

function identifier(value, field, code) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    fail(code, `${field} must be a canonical identifier.`, { field });
  }
  return value;
}

function digest(value, field, code) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    fail(code, `${field} must be a lowercase SHA-256 digest.`, { field });
  }
  return value;
}

function canonicalTimestamp(value, field, code) {
  if (
    typeof value !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
    || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) {
    fail(code, `${field} must be a canonical UTC timestamp.`, { field });
  }
  return value;
}

function positiveInteger(value, field, maximum, code) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    fail(code, `${field} must be a whole number from 1 to ${maximum}.`, {
      field,
      maximum
    });
  }
  return value;
}

function nonnegativeInteger(value, field, maximum, code) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    fail(code, `${field} must be a whole number from 0 to ${maximum}.`, {
      field,
      maximum
    });
  }
  return value;
}

function boundedText(value, field, maximum, code, { allowEmpty = false } = {}) {
  if (
    typeof value !== 'string'
    || (!allowEmpty && value.length < 1)
    || value.length > maximum
  ) {
    fail(code, `${field} is outside its safe text limit.`, {
      field,
      maximum
    });
  }
  return value;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
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
  return crypto.createHash('sha256')
    .update(`${canonicalJson(value)}\n`)
    .digest('hex');
}

function canonicalEqual(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function canonicalProject(rawProject) {
  try {
    return normalizeServiceProject(rawProject);
  } catch (error) {
    fail(
      'INVALID_PROJECT',
      'The service project is not valid for reviewed song replacement.',
      { causeCode: error?.code || null }
    );
  }
}

function serviceProjectRevisionId(project) {
  return crypto.createHash('sha256')
    .update(serializeServiceProject(project))
    .digest('hex');
}

function normalizeServiceSetBinding(raw, field, code) {
  exactKeys(
    raw,
    ['id', 'fingerprint', 'serviceDate', 'profileId'],
    [],
    field,
    code
  );
  if (
    typeof raw.serviceDate !== 'string'
    || !/^\d{4}-\d{2}-\d{2}$/u.test(raw.serviceDate)
  ) {
    fail(code, `${field}.serviceDate must use YYYY-MM-DD.`, { field });
  }
  return {
    id: identifier(raw.id, `${field}.id`, code),
    fingerprint: digest(raw.fingerprint, `${field}.fingerprint`, code),
    serviceDate: raw.serviceDate,
    profileId: identifier(raw.profileId, `${field}.profileId`, code)
  };
}

function serviceSetBindingFromReview(raw, field, code) {
  if (!isRecord(raw)) fail(code, `${field} must be an object.`, { field });
  return normalizeServiceSetBinding({
    id: raw.id,
    fingerprint: raw.fingerprint,
    serviceDate: raw.serviceDate,
    profileId: raw.profileId
  }, field, code);
}

function requireLocalReviewConfirmations(raw, field) {
  exactKeys(raw, [
    'sourceConfirmed',
    'rightsConfirmed',
    'localCommitConfirmed',
    'authorityScope',
    'communityAuthorityGranted'
  ], [], field, 'INVALID_REVIEW_LOOKUP');
  if (
    raw.sourceConfirmed !== true
    || raw.rightsConfirmed !== true
    || raw.localCommitConfirmed !== true
    || raw.authorityScope
      !== SONG_FAMILY_REVIEW_CONFIRMATION_AUTHORITY_SCOPE
    || raw.communityAuthorityGranted !== false
  ) {
    fail(
      'REVIEW_NOT_CONFIRMED',
      'The durable song-family review does not contain all local-only confirmations.'
    );
  }
}

function canonicalSongMember(member, index) {
  if (!isRecord(member)) {
    fail(
      'INVALID_REVIEW_LOOKUP',
      `Reviewed family member ${index + 1} must be an object.`
    );
  }
  const songId = identifier(
    member.songId,
    `Reviewed family member ${index + 1} songId`,
    'INVALID_REVIEW_LOOKUP'
  );
  const revision = digest(
    member.reviewedRevision,
    `Reviewed family member ${songId} revision`,
    'INVALID_REVIEW_LOOKUP'
  );
  const documentSource = boundedText(
    member.documentSource,
    `Reviewed family member ${songId} documentSource`,
    MAX_SOURCE_BYTES,
    'INVALID_REVIEW_LOOKUP'
  );
  let document;
  try {
    document = parseSongDocument(documentSource, {
      fileName: `${songId}.md`
    });
  } catch (error) {
    fail(
      'INVALID_REVIEW_LOOKUP',
      `Reviewed family member ${songId} is not a valid SongDocument.`,
      { songId, causeCode: error?.code || null }
    );
  }
  const canonicalSource = serializeSongDocument(document);
  if (
    canonicalSource !== documentSource
    || document.id !== songId
    || canonicalHashForBytes(canonicalSource) !== revision
  ) {
    fail(
      'REVIEW_REVISION_MISMATCH',
      `Reviewed family member ${songId} no longer matches its exact revision.`,
      { songId }
    );
  }
  const translationOf = member.translationOf === null
    ? null
    : identifier(
        member.translationOf,
        `Reviewed family member ${songId} translationOf`,
        'INVALID_REVIEW_LOOKUP'
      );
  if (
    document.translationOf !== translationOf
    || !['original', 'translation'].includes(member.familyRole)
    || (member.familyRole === 'original' && translationOf !== null)
    || (member.familyRole === 'translation' && translationOf === null)
  ) {
    fail(
      'REVIEW_FAMILY_MISMATCH',
      `Reviewed family member ${songId} has inconsistent family metadata.`,
      { songId }
    );
  }
  return {
    raw: member,
    songId,
    revision,
    document,
    documentSource,
    translationOf
  };
}

function canonicalHashForBytes(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function receiptOccurrencesMatchSnapshot(snapshotOccurrences, receiptOccurrences) {
  if (
    !Array.isArray(snapshotOccurrences)
    || !Array.isArray(receiptOccurrences)
    || snapshotOccurrences.length !== receiptOccurrences.length
  ) {
    return false;
  }
  return snapshotOccurrences.every((snapshotOccurrence, index) => {
    const receiptOccurrence = receiptOccurrences[index];
    if (
      !isRecord(snapshotOccurrence)
      || !isRecord(receiptOccurrence)
      || snapshotOccurrence.occurrenceId !== receiptOccurrence.occurrenceId
      || snapshotOccurrence.action !== receiptOccurrence.action
      || snapshotOccurrence.sectionId !== receiptOccurrence.sectionId
      || snapshotOccurrence.repeatOfOccurrenceId
        !== receiptOccurrence.repeatOfOccurrenceId
      || !Array.isArray(snapshotOccurrence.evidence)
      || !Array.isArray(receiptOccurrence.evidence)
      || snapshotOccurrence.evidence.length !== receiptOccurrence.evidence.length
    ) {
      return false;
    }
    return snapshotOccurrence.evidence.every((snapshotEvidence, evidenceIndex) => {
      const receiptEvidence = receiptOccurrence.evidence[evidenceIndex];
      return snapshotEvidence.songId === receiptEvidence?.songId
        && snapshotEvidence.captureOrdinal === receiptEvidence.captureOrdinal
        && snapshotEvidence.slideNumber === receiptEvidence.slideNumber
        && SHA256_PATTERN.test(receiptEvidence.textSha256 || '');
    });
  });
}

function validateDurableReviewLookup(rawLookup) {
  exactKeys(
    rawLookup,
    ['snapshot', 'receipt', 'reviewStatus'],
    [],
    'Durable song-family review lookup',
    'INVALID_REVIEW_LOOKUP'
  );
  exactKeys(
    rawLookup.snapshot,
    ['snapshotHash', 'snapshot'],
    [],
    'Durable song-family review snapshot',
    'INVALID_REVIEW_LOOKUP'
  );
  const snapshotHash = digest(
    rawLookup.snapshot.snapshotHash,
    'Review snapshot hash',
    'INVALID_REVIEW_LOOKUP'
  );
  const snapshot = rawLookup.snapshot.snapshot;
  exactKeys(snapshot, [
    'schemaVersion',
    'kind',
    'reviewScope',
    'confirmations',
    'reviewedAt',
    'serviceSet',
    'family'
  ], [], 'Reviewed song-family snapshot', 'INVALID_REVIEW_LOOKUP');
  if (
    snapshot.schemaVersion !== SONG_FAMILY_REVIEW_SNAPSHOT_SCHEMA_VERSION
    || snapshot.kind !== SONG_FAMILY_REVIEW_SNAPSHOT_KIND
    || snapshot.reviewScope !== SONG_FAMILY_REVIEW_SCOPE
    || canonicalHash(snapshot) !== snapshotHash
  ) {
    fail(
      'INVALID_REVIEW_LOOKUP',
      'The durable song-family snapshot does not match its exact saved hash.'
    );
  }
  requireLocalReviewConfirmations(
    snapshot.confirmations,
    'Reviewed song-family snapshot confirmations'
  );

  const receipt = rawLookup.receipt;
  exactKeys(receipt, [
    'receiptHash',
    'schemaVersion',
    'kind',
    'reviewScope',
    'confirmations',
    'snapshotHash',
    'reviewedAt',
    'committedAt',
    'serviceSet',
    'captureSetHash',
    'rootSongId',
    'familyRevision',
    'results',
    'occurrences'
  ], [], 'Durable song-family receipt', 'INVALID_REVIEW_LOOKUP');
  const receiptHash = digest(
    receipt.receiptHash,
    'Review receipt hash',
    'INVALID_REVIEW_LOOKUP'
  );
  const receiptRecord = { ...receipt };
  delete receiptRecord.receiptHash;
  if (
    receipt.schemaVersion !== SONG_FAMILY_REVIEW_RECEIPT_SCHEMA_VERSION
    || receipt.kind !== SONG_FAMILY_REVIEW_RECEIPT_KIND
    || receipt.reviewScope !== SONG_FAMILY_REVIEW_SCOPE
    || receipt.snapshotHash !== snapshotHash
    || canonicalHash(receiptRecord) !== receiptHash
  ) {
    fail(
      'INVALID_REVIEW_LOOKUP',
      'The durable song-family receipt does not match its exact saved hash.'
    );
  }
  requireLocalReviewConfirmations(
    receipt.confirmations,
    'Reviewed song-family receipt confirmations'
  );
  if (!canonicalEqual(snapshot.confirmations, receipt.confirmations)) {
    fail(
      'REVIEW_RECEIPT_MISMATCH',
      'The snapshot and receipt confirmations do not match.'
    );
  }

  const status = rawLookup.reviewStatus;
  exactKeys(status, [
    'snapshotHash',
    'reviewed',
    'receipts',
    'skippedCorruptReceipts'
  ], [], 'Durable song-family review status', 'INVALID_REVIEW_LOOKUP');
  if (
    status.snapshotHash !== snapshotHash
    || status.reviewed !== true
    || status.skippedCorruptReceipts !== 0
    || !Array.isArray(status.receipts)
    || status.receipts.length !== 1
    || !canonicalEqual(status.receipts[0], receipt)
  ) {
    fail(
      'REVIEW_EVIDENCE_UNAVAILABLE',
      'The exact durable song-family review is missing, ambiguous, or corrupt.'
    );
  }

  const snapshotServiceSet = serviceSetBindingFromReview(
    snapshot.serviceSet,
    'Reviewed snapshot service set',
    'INVALID_REVIEW_LOOKUP'
  );
  const receiptServiceSet = serviceSetBindingFromReview(
    receipt.serviceSet,
    'Reviewed receipt service set',
    'INVALID_REVIEW_LOOKUP'
  );
  if (
    !canonicalEqual(snapshotServiceSet, receiptServiceSet)
    || snapshot.reviewedAt !== receipt.reviewedAt
  ) {
    fail(
      'REVIEW_RECEIPT_MISMATCH',
      'The snapshot and durable receipt belong to different review evidence.'
    );
  }

  if (
    !isRecord(snapshot.family)
    || !Array.isArray(snapshot.family.members)
    || snapshot.family.members.length < 1
    || snapshot.family.members.length > MAX_FAMILY_RESOURCES
    || !Array.isArray(snapshot.family.occurrences)
    || snapshot.family.occurrences.length < 1
    || snapshot.family.occurrences.length >= MAX_SOURCE_RANGE_ITEMS
  ) {
    fail(
      'INVALID_REVIEW_LOOKUP',
      'The reviewed song family is outside replacement safety limits.'
    );
  }
  const rootSongId = identifier(
    snapshot.family.rootSongId,
    'Reviewed family root song id',
    'INVALID_REVIEW_LOOKUP'
  );
  if (
    receipt.rootSongId !== rootSongId
    || !receiptOccurrencesMatchSnapshot(
      snapshot.family.occurrences,
      receipt.occurrences
    )
  ) {
    fail(
      'REVIEW_RECEIPT_MISMATCH',
      'The durable receipt does not commit this exact reviewed song family.'
    );
  }
  if (snapshot.family.occurrences.some(item => item?.action === 'exclude')) {
    fail(
      'EXCLUDED_OCCURRENCE',
      'A reviewed source range with an excluded occurrence cannot replace exact source pictures.'
    );
  }
  if (snapshot.family.occurrences.some(item =>
    !isRecord(item)
    || !['new', 'repeat'].includes(item.action)
    || typeof item.sectionId !== 'string'
    || !Array.isArray(item.evidence))) {
    fail(
      'INVALID_REVIEW_LOOKUP',
      'Every reviewed occurrence must be a committed new or repeat section.'
    );
  }

  const members = snapshot.family.members.map(canonicalSongMember);
  const memberIds = new Set(members.map(member => member.songId));
  if (memberIds.size !== members.length) {
    fail('REVIEW_FAMILY_MISMATCH', 'The reviewed song family repeats a song id.');
  }
  const root = members.find(member => member.songId === rootSongId);
  if (!root || root.translationOf !== null) {
    fail(
      'REVIEW_FAMILY_MISMATCH',
      'The reviewed family root is missing or is itself a translation.'
    );
  }
  for (const member of members) {
    if (
      member.songId !== rootSongId
      && member.translationOf !== rootSongId
    ) {
      fail(
        'REVIEW_FAMILY_MISMATCH',
        `Reviewed member ${member.songId} does not belong to the root family.`,
        { songId: member.songId }
      );
    }
  }
  const computedFamilyRevision = songFamilyRevision(members.map(member => ({
    song: member.document,
    revision: member.revision
  })));
  if (
    computedFamilyRevision !== receipt.familyRevision
    || !SHA256_PATTERN.test(receipt.familyRevision)
  ) {
    fail(
      'REVIEW_FAMILY_REVISION_MISMATCH',
      'The durable receipt does not match the exact reviewed family revision.'
    );
  }
  if (
    !Array.isArray(receipt.results)
    || receipt.results.length !== members.length
  ) {
    fail(
      'REVIEW_RECEIPT_MISMATCH',
      'The durable receipt does not cover every reviewed family member.'
    );
  }
  const resultsBySongId = new Map(
    receipt.results.map(result => [result?.songId, result])
  );
  if (resultsBySongId.size !== members.length) {
    fail('REVIEW_RECEIPT_MISMATCH', 'The receipt repeats a family member.');
  }
  for (const member of members) {
    const result = resultsBySongId.get(member.songId);
    if (
      !result
      || result.resultingRevision !== member.revision
      || result.familyRole !== member.raw.familyRole
      || result.translationOf !== member.translationOf
      || result.action !== member.raw.action
      || result.previousRevision !== member.raw.expectedRevision
      || result.finalTextSha256 !== member.raw.finalTextSha256
      || !canonicalEqual(
        result.localServiceRights,
        member.raw.localServiceRights
      )
    ) {
      fail(
        'REVIEW_RECEIPT_MISMATCH',
        `The receipt result for ${member.songId} does not match the reviewed member.`,
        { songId: member.songId }
      );
    }
  }
  return {
    snapshotHash,
    snapshot,
    receiptHash,
    receipt,
    serviceSet: snapshotServiceSet,
    rootSongId,
    familyRevision: computedFamilyRevision,
    members,
    root,
    occurrences: snapshot.family.occurrences
  };
}

function normalizeChannelMappings(rawMappings, channelIds, code) {
  if (
    !Array.isArray(rawMappings)
    || rawMappings.length !== channelIds.length
    || rawMappings.length < 1
    || rawMappings.length > MAX_CHANNEL_MAPPINGS
  ) {
    fail(
      code,
      'Channel mappings must cover every project output exactly once.'
    );
  }
  const byChannelId = new Map();
  for (const [index, raw] of rawMappings.entries()) {
    if (!isRecord(raw)) {
      fail(code, `Channel mapping ${index + 1} must be an object.`);
    }
    const mode = raw.mode;
    if (mode === 'hidden' || mode === 'hide') {
      fail(
        'HIDDEN_CHANNEL_NOT_ALLOWED',
        'Reviewed song replacement cannot hide a project output.',
        { channelId: raw.channelId || null }
      );
    }
    let normalized;
    if (mode === 'content') {
      exactKeys(raw, [
        'channelId',
        'mode',
        'songId',
        'songRevisionId',
        'sourceRoleId'
      ], [], `Channel mapping ${index + 1}`, code);
      normalized = {
        channelId: identifier(
          raw.channelId,
          `Channel mapping ${index + 1} channelId`,
          code
        ),
        mode: 'content',
        songId: identifier(
          raw.songId,
          `Channel mapping ${index + 1} songId`,
          code
        ),
        songRevisionId: digest(
          raw.songRevisionId,
          `Channel mapping ${index + 1} songRevisionId`,
          code
        ),
        sourceRoleId: identifier(
          raw.sourceRoleId,
          `Channel mapping ${index + 1} sourceRoleId`,
          code
        )
      };
    } else if (mode === 'inherit') {
      exactKeys(
        raw,
        ['channelId', 'mode', 'from'],
        [],
        `Channel mapping ${index + 1}`,
        code
      );
      normalized = {
        channelId: identifier(
          raw.channelId,
          `Channel mapping ${index + 1} channelId`,
          code
        ),
        mode: 'inherit',
        from: identifier(
          raw.from,
          `Channel mapping ${index + 1} from`,
          code
        )
      };
    } else if (mode === 'derive') {
      exactKeys(
        raw,
        ['channelId', 'mode', 'from', 'transform'],
        [],
        `Channel mapping ${index + 1}`,
        code
      );
      exactKeys(
        raw.transform,
        ['id', 'version', 'maxLines'],
        [],
        `Channel mapping ${index + 1} transform`,
        code
      );
      if (
        raw.transform.id !== 'first-lines'
        || raw.transform.version !== 1
      ) {
        fail(
          code,
          'Derived song outputs must use first-lines transform version 1.'
        );
      }
      normalized = {
        channelId: identifier(
          raw.channelId,
          `Channel mapping ${index + 1} channelId`,
          code
        ),
        mode: 'derive',
        from: identifier(
          raw.from,
          `Channel mapping ${index + 1} from`,
          code
        ),
        transform: {
          id: 'first-lines',
          version: 1,
          maxLines: positiveInteger(
            raw.transform.maxLines,
            `Channel mapping ${index + 1} transform maxLines`,
            8,
            code
          )
        }
      };
    } else {
      fail(
        code,
        `Channel mapping ${index + 1} has unsupported mode ${mode}.`
      );
    }
    if (
      !channelIds.includes(normalized.channelId)
      || byChannelId.has(normalized.channelId)
    ) {
      fail(
        'CHANNEL_MAPPING_MISMATCH',
        'Channel mappings must cover every project output exactly once.',
        { channelId: normalized.channelId }
      );
    }
    byChannelId.set(normalized.channelId, normalized);
  }
  const mappings = channelIds.map(channelId => {
    const mapping = byChannelId.get(channelId);
    if (!mapping) {
      fail(
        'CHANNEL_MAPPING_MISMATCH',
        `Project output ${channelId} has no reviewed song mapping.`,
        { channelId }
      );
    }
    return mapping;
  });

  const byId = new Map(mappings.map(mapping => [mapping.channelId, mapping]));
  const resolvedContentByChannelId = new Map();
  const resolve = (channelId, path = []) => {
    if (resolvedContentByChannelId.has(channelId)) {
      return resolvedContentByChannelId.get(channelId);
    }
    if (path.includes(channelId)) {
      fail(
        'CHANNEL_MAPPING_CYCLE',
        'Reviewed song channel mappings contain an inheritance cycle.',
        { channelId, path: [...path, channelId] }
      );
    }
    const mapping = byId.get(channelId);
    if (!mapping) {
      fail(
        'UNMAPPED_CHANNEL_REFERENCE',
        `Reviewed song mapping refers to missing project output ${channelId}.`,
        { channelId }
      );
    }
    const content = mapping.mode === 'content'
      ? mapping
      : resolve(mapping.from, [...path, channelId]);
    resolvedContentByChannelId.set(channelId, content);
    return content;
  };
  for (const channelId of channelIds) resolve(channelId);
  return { mappings, resolvedContentByChannelId };
}

function reviewedCaptureForMapping(review, mapping) {
  const member = review.members.find(candidate =>
    candidate.songId === mapping.songId);
  if (!member || member.revision !== mapping.songRevisionId) {
    fail(
      'CHANNEL_SONG_REVISION_MISMATCH',
      `Output ${mapping.channelId} is not mapped to an exact reviewed song revision.`,
      { channelId: mapping.channelId, songId: mapping.songId }
    );
  }
  const captures = Array.isArray(member.raw.captures)
    ? member.raw.captures.filter(capture =>
        capture?.roleId === mapping.sourceRoleId)
    : [];
  if (captures.length !== 1) {
    fail(
      'SOURCE_CAPTURE_MISSING',
      `Output ${mapping.channelId} needs one exact reviewed source capture.`,
      {
        channelId: mapping.channelId,
        songId: mapping.songId,
        sourceRoleId: mapping.sourceRoleId
      }
    );
  }
  const capture = captures[0];
  if (capture.selectionOrigin !== 'template-local') {
    fail(
      'MANUAL_SOURCE_SELECTION',
      `Output ${mapping.channelId} uses a manual capture that cannot replace exact source pictures.`,
      { channelId: mapping.channelId }
    );
  }
  if (!Number.isSafeInteger(capture.titleSlide) || capture.titleSlide < 1) {
    fail(
      'MISSING_TITLE_SLIDE',
      `Output ${mapping.channelId} has no exact reviewed title slide.`,
      { channelId: mapping.channelId }
    );
  }
  if (
    !Number.isSafeInteger(capture.ordinal)
    || capture.ordinal < 1
    || !Array.isArray(capture.slides)
    || capture.slides.length !== review.occurrences.length
  ) {
    fail(
      'SOURCE_CAPTURE_MISMATCH',
      `Output ${mapping.channelId} capture does not cover every reviewed occurrence.`,
      { channelId: mapping.channelId }
    );
  }
  const deck = Array.isArray(review.snapshot.serviceSet.decks)
    ? review.snapshot.serviceSet.decks.find(candidate =>
        candidate?.roleId === mapping.sourceRoleId
        && candidate?.deckSha256 === capture.deckSha256)
    : null;
  if (!deck) {
    fail(
      'SOURCE_CAPTURE_MISMATCH',
      `Output ${mapping.channelId} capture is not pinned to its reviewed source deck.`,
      { channelId: mapping.channelId }
    );
  }
  const positions = [capture.titleSlide];
  for (const [index, occurrence] of review.occurrences.entries()) {
    const slide = capture.slides[index];
    if (!Number.isSafeInteger(slide?.number) || slide.number < 1) {
      fail(
        'SOURCE_CAPTURE_MISMATCH',
        `Output ${mapping.channelId} capture has an invalid slide position.`,
        { channelId: mapping.channelId, occurrenceId: occurrence.occurrenceId }
      );
    }
    const evidence = occurrence.evidence.filter(candidate =>
      candidate?.songId === member.songId
      && candidate?.captureOrdinal === capture.ordinal);
    if (
      evidence.length !== 1
      || evidence[0].slideNumber !== slide.number
    ) {
      fail(
        'SOURCE_CAPTURE_MISMATCH',
        `Output ${mapping.channelId} occurrence evidence does not match its exact capture.`,
        { channelId: mapping.channelId, occurrenceId: occurrence.occurrenceId }
      );
    }
    positions.push(slide.number);
  }
  for (let index = 1; index < positions.length; index += 1) {
    if (positions[index] !== positions[index - 1] + 1) {
      fail(
        'NONCONSECUTIVE_SOURCE_RANGE',
        'Reviewed title and lyric slides must form one consecutive source range.',
        { channelId: mapping.channelId, positions }
      );
    }
  }
  const expectedCandidateId =
    `slides-${positions[0]}-${positions[1]}-${positions.at(-1)}`;
  if (capture.candidateId !== expectedCandidateId) {
    fail(
      'SOURCE_CAPTURE_MISMATCH',
      `Output ${mapping.channelId} capture does not identify its exact template-local range.`,
      {
        channelId: mapping.channelId,
        expectedCandidateId,
        actualCandidateId: capture.candidateId
      }
    );
  }
  return { member, capture, positions };
}

function exactReviewedPositions(review, contentMappings) {
  const reviewed = contentMappings.map(mapping =>
    reviewedCaptureForMapping(review, mapping));
  const expected = reviewed[0]?.positions;
  if (!expected) {
    fail(
      'CHANNEL_MAPPING_MISMATCH',
      'At least one direct reviewed song channel is required.'
    );
  }
  for (let index = 1; index < reviewed.length; index += 1) {
    if (!canonicalEqual(expected, reviewed[index].positions)) {
      fail(
        'UNEQUAL_SOURCE_POSITIONS',
        'Every direct song output must identify the same title and lyric slide positions.',
        {
          expected,
          channelId: contentMappings[index].channelId,
          actual: reviewed[index].positions
        }
      );
    }
  }
  return { reviewed, positions: expected };
}

function siblingCollections(project) {
  const collections = [{
    parentId: null,
    itemIds: project.rootItemIds
  }];
  for (const item of Object.values(project.items)) {
    if (item.kind === 'group') {
      collections.push({ parentId: item.id, itemIds: item.childIds });
    }
  }
  return collections;
}

function sourceVisualMatches(item, serviceSet, renderRevisionId, position) {
  const review = item?.sourceVisualReview;
  return item?.kind === 'picture'
    && review?.schemaVersion === 1
    && review?.kind === 'powerpoint-render'
    && review.serviceSetId === serviceSet.id
    && review.serviceSetFingerprint === serviceSet.fingerprint
    && review.renderRevisionId === renderRevisionId
    && review.position === position
    && canonicalEqual(review.assetIdsByChannel, item.assetIdsByChannel);
}

function requireCompletePictureChannels(item, channelIds) {
  const actual = Object.keys(item.assetIdsByChannel || {});
  if (
    actual.length !== channelIds.length
    || channelIds.some(channelId =>
      !Object.prototype.hasOwnProperty.call(
        item.assetIdsByChannel || {},
        channelId
      ))
  ) {
    fail(
      'SOURCE_PICTURE_CHANNEL_MISMATCH',
      `Source picture ${item.id} does not contain every project output image.`,
      { itemId: item.id }
    );
  }
}

function locateExactSourceRange(project, serviceSet, positions) {
  const candidates = [];
  for (const collection of siblingCollections(project)) {
    if (collection.itemIds.length < positions.length) continue;
    for (
      let index = 0;
      index <= collection.itemIds.length - positions.length;
      index += 1
    ) {
      const first = project.items[collection.itemIds[index]];
      const renderRevisionId = first?.sourceVisualReview?.renderRevisionId;
      if (
        !SHA256_PATTERN.test(renderRevisionId || '')
        || !sourceVisualMatches(
          first,
          serviceSet,
          renderRevisionId,
          positions[0]
        )
      ) {
        continue;
      }
      const items = collection.itemIds
        .slice(index, index + positions.length)
        .map(itemId => project.items[itemId]);
      if (!items.every((item, itemIndex) =>
        sourceVisualMatches(
          item,
          serviceSet,
          renderRevisionId,
          positions[itemIndex]
        ))) {
        continue;
      }
      for (const item of items) {
        requireCompletePictureChannels(item, project.channelIds);
      }
      candidates.push({
        parentId: collection.parentId,
        index,
        renderRevisionId,
        items
      });
    }
  }
  if (candidates.length < 1) {
    fail(
      'SOURCE_RANGE_NOT_CONTIGUOUS',
      'The exact reviewed title and lyric pictures are missing or no longer contiguous.'
    );
  }
  if (candidates.length > 1) {
    fail(
      'AMBIGUOUS_SOURCE_RANGE',
      'More than one exact reviewed picture range matches this song family.'
    );
  }
  return candidates[0];
}

function normalizeProjectBinding(raw, code) {
  exactKeys(raw, [
    'projectId',
    'projectRevisionId',
    'projectRevision',
    'updatedAt',
    'channelIds',
    'serviceSet'
  ], [], 'Proposal project binding', code);
  if (
    !Array.isArray(raw.channelIds)
    || raw.channelIds.length < 1
    || raw.channelIds.length > MAX_CHANNEL_MAPPINGS
  ) {
    fail(code, 'Proposal project channel IDs are invalid.');
  }
  const channelIds = raw.channelIds.map((channelId, index) =>
    identifier(channelId, `Proposal project channel ${index + 1}`, code));
  if (new Set(channelIds).size !== channelIds.length) {
    fail(code, 'Proposal project channel IDs contain duplicates.');
  }
  return {
    projectId: identifier(raw.projectId, 'Proposal project id', code),
    projectRevisionId: digest(
      raw.projectRevisionId,
      'Proposal project revision id',
      code
    ),
    projectRevision: nonnegativeInteger(
      raw.projectRevision,
      'Proposal project revision',
      Number.MAX_SAFE_INTEGER,
      code
    ),
    updatedAt: canonicalTimestamp(
      raw.updatedAt,
      'Proposal project updatedAt',
      code
    ),
    channelIds,
    serviceSet: normalizeServiceSetBinding(
      raw.serviceSet,
      'Proposal project service set',
      code
    )
  };
}

function normalizeReviewBinding(raw, code) {
  exactKeys(raw, [
    'snapshotHash',
    'receiptHash',
    'rootSongId',
    'familyRevision'
  ], [], 'Proposal review binding', code);
  return {
    snapshotHash: digest(
      raw.snapshotHash,
      'Proposal review snapshot hash',
      code
    ),
    receiptHash: digest(
      raw.receiptHash,
      'Proposal review receipt hash',
      code
    ),
    rootSongId: identifier(
      raw.rootSongId,
      'Proposal review root song id',
      code
    ),
    familyRevision: digest(
      raw.familyRevision,
      'Proposal review family revision',
      code
    )
  };
}

function normalizeItemFingerprints(raw, itemIds, code) {
  if (!Array.isArray(raw) || raw.length !== itemIds.length) {
    fail(code, 'Proposal source item fingerprints do not cover the range.');
  }
  return raw.map((entry, index) => {
    exactKeys(
      entry,
      ['itemId', 'fingerprint'],
      [],
      `Proposal source fingerprint ${index + 1}`,
      code
    );
    const normalized = {
      itemId: identifier(
        entry.itemId,
        `Proposal source fingerprint ${index + 1} itemId`,
        code
      ),
      fingerprint: digest(
        entry.fingerprint,
        `Proposal source fingerprint ${index + 1} digest`,
        code
      )
    };
    if (normalized.itemId !== itemIds[index]) {
      fail(code, 'Proposal source item fingerprints are out of order.');
    }
    return normalized;
  });
}

function normalizeSourceRange(raw, code) {
  exactKeys(raw, [
    'parentId',
    'index',
    'renderRevisionId',
    'startPosition',
    'endPosition',
    'itemIds',
    'itemFingerprints'
  ], [], 'Proposal source range', code);
  if (
    !Array.isArray(raw.itemIds)
    || raw.itemIds.length < 2
    || raw.itemIds.length > MAX_SOURCE_RANGE_ITEMS
  ) {
    fail(code, 'Proposal source range is outside its safety limit.');
  }
  const itemIds = raw.itemIds.map((itemId, index) =>
    identifier(itemId, `Proposal source item ${index + 1}`, code));
  if (new Set(itemIds).size !== itemIds.length) {
    fail(code, 'Proposal source range repeats an item id.');
  }
  const startPosition = positiveInteger(
    raw.startPosition,
    'Proposal source start position',
    5000,
    code
  );
  const endPosition = positiveInteger(
    raw.endPosition,
    'Proposal source end position',
    5000,
    code
  );
  if (endPosition - startPosition + 1 !== itemIds.length) {
    fail(code, 'Proposal source positions are not one consecutive range.');
  }
  return {
    parentId: raw.parentId === null
      ? null
      : identifier(raw.parentId, 'Proposal source parent id', code),
    index: nonnegativeInteger(
      raw.index,
      'Proposal source index',
      5000,
      code
    ),
    renderRevisionId: digest(
      raw.renderRevisionId,
      'Proposal render revision id',
      code
    ),
    startPosition,
    endPosition,
    itemIds,
    itemFingerprints: normalizeItemFingerprints(
      raw.itemFingerprints,
      itemIds,
      code
    )
  };
}

function normalizeSongResources(raw, code) {
  if (
    !Array.isArray(raw)
    || raw.length < 1
    || raw.length > MAX_FAMILY_RESOURCES
  ) {
    fail(code, 'Proposal song resources are outside their safety limit.');
  }
  const resources = raw.map((entry, index) => {
    exactKeys(
      entry,
      ['songId', 'revision', 'documentSource'],
      [],
      `Proposal song resource ${index + 1}`,
      code
    );
    const songId = identifier(
      entry.songId,
      `Proposal song resource ${index + 1} songId`,
      code
    );
    const revision = digest(
      entry.revision,
      `Proposal song resource ${songId} revision`,
      code
    );
    const documentSource = boundedText(
      entry.documentSource,
      `Proposal song resource ${songId} source`,
      MAX_SOURCE_BYTES,
      code
    );
    let document;
    try {
      document = parseSongDocument(documentSource, {
        fileName: `${songId}.md`
      });
    } catch (error) {
      fail(code, `Proposal song resource ${songId} is invalid.`, {
        songId,
        causeCode: error?.code || null
      });
    }
    if (
      document.id !== songId
      || serializeSongDocument(document) !== documentSource
      || canonicalHashForBytes(documentSource) !== revision
    ) {
      fail(
        'PROPOSAL_RESOURCE_REVISION_MISMATCH',
        `Proposal song resource ${songId} does not match its exact revision.`,
        { songId }
      );
    }
    return { songId, revision, documentSource, document };
  }).sort((left, right) => left.songId.localeCompare(right.songId, 'en'));
  if (new Set(resources.map(resource => resource.songId)).size
    !== resources.length) {
    fail(code, 'Proposal song resources repeat a song id.');
  }
  return resources;
}

function normalizeSourceRangeReplacement(raw, code) {
  exactKeys(raw, [
    'schemaVersion',
    'kind',
    'serviceSetId',
    'serviceSetFingerprint',
    'renderRevisionId',
    'sourceProjectRevisionId',
    'startPosition',
    'endPosition',
    'sourceItemIds',
    'sourceItemsSha256',
    'snapshotHash',
    'receiptHash',
    'rootSongId',
    'familyRevision'
  ], [], 'Song source-range replacement receipt', code);
  if (
    raw.schemaVersion !== SOURCE_RANGE_REPLACEMENT_SCHEMA_VERSION
    || raw.kind !== SOURCE_RANGE_REPLACEMENT_KIND
    || !Array.isArray(raw.sourceItemIds)
    || raw.sourceItemIds.length < 2
    || raw.sourceItemIds.length > MAX_SOURCE_RANGE_ITEMS
  ) {
    fail(code, 'Song source-range replacement receipt is invalid.');
  }
  const sourceItemIds = raw.sourceItemIds.map((itemId, index) =>
    identifier(
      itemId,
      `Song source-range replacement item ${index + 1}`,
      code
    ));
  return {
    schemaVersion: SOURCE_RANGE_REPLACEMENT_SCHEMA_VERSION,
    kind: SOURCE_RANGE_REPLACEMENT_KIND,
    serviceSetId: identifier(
      raw.serviceSetId,
      'Song source-range replacement serviceSetId',
      code
    ),
    serviceSetFingerprint: digest(
      raw.serviceSetFingerprint,
      'Song source-range replacement serviceSetFingerprint',
      code
    ),
    renderRevisionId: digest(
      raw.renderRevisionId,
      'Song source-range replacement renderRevisionId',
      code
    ),
    sourceProjectRevisionId: digest(
      raw.sourceProjectRevisionId,
      'Song source-range replacement sourceProjectRevisionId',
      code
    ),
    startPosition: positiveInteger(
      raw.startPosition,
      'Song source-range replacement startPosition',
      5000,
      code
    ),
    endPosition: positiveInteger(
      raw.endPosition,
      'Song source-range replacement endPosition',
      5000,
      code
    ),
    sourceItemIds,
    sourceItemsSha256: digest(
      raw.sourceItemsSha256,
      'Song source-range replacement sourceItemsSha256',
      code
    ),
    snapshotHash: digest(
      raw.snapshotHash,
      'Song source-range replacement snapshotHash',
      code
    ),
    receiptHash: digest(
      raw.receiptHash,
      'Song source-range replacement receiptHash',
      code
    ),
    rootSongId: identifier(
      raw.rootSongId,
      'Song source-range replacement rootSongId',
      code
    ),
    familyRevision: digest(
      raw.familyRevision,
      'Song source-range replacement familyRevision',
      code
    )
  };
}

function variantFromMapping(mapping) {
  if (mapping.mode === 'content') {
    return {
      mode: 'content',
      resourceId: `sha256:${mapping.songRevisionId}`
    };
  }
  if (mapping.mode === 'inherit') {
    return { mode: 'inherit', from: mapping.from };
  }
  return {
    mode: 'derive',
    from: mapping.from,
    transform: mapping.transform
  };
}

function normalizeReplacementItem(
  raw,
  {
    createdAt,
    mappings,
    projectBinding,
    reviewBinding,
    sourceRange,
    resources,
    cueCount
  },
  code
) {
  exactKeys(raw, [
    'id',
    'kind',
    'title',
    'createdAt',
    'updatedAt',
    'operatorNotes',
    'variants',
    'arrangement',
    'primaryChannelId',
    'titlePresetId',
    'lyricsPresetId',
    'sourceRangeReplacement'
  ], [], 'Proposal replacement item', code);
  if (raw.kind !== 'song') {
    fail(code, 'Proposal replacement item must be a semantic song.');
  }
  const item = {
    id: identifier(raw.id, 'Proposal replacement item id', code),
    kind: 'song',
    title: boundedText(
      raw.title,
      'Proposal replacement item title',
      200,
      code
    ),
    createdAt: canonicalTimestamp(
      raw.createdAt,
      'Proposal replacement item createdAt',
      code
    ),
    updatedAt: canonicalTimestamp(
      raw.updatedAt,
      'Proposal replacement item updatedAt',
      code
    ),
    operatorNotes: boundedText(
      raw.operatorNotes,
      'Proposal replacement item operatorNotes',
      4000,
      code,
      { allowEmpty: true }
    )
  };
  if (
    item.createdAt !== createdAt
    || item.updatedAt !== createdAt
    || item.operatorNotes !== ''
    || !isRecord(raw.variants)
  ) {
    fail(code, 'Proposal replacement item contains noncanonical metadata.');
  }
  const variants = {};
  for (const mapping of mappings) {
    const expected = variantFromMapping(mapping);
    if (!canonicalEqual(raw.variants[mapping.channelId], expected)) {
      fail(
        'PROPOSAL_CHANNEL_MISMATCH',
        `Proposal replacement output ${mapping.channelId} does not match its reviewed mapping.`,
        { channelId: mapping.channelId }
      );
    }
    variants[mapping.channelId] = expected;
  }
  if (Object.keys(raw.variants).length !== mappings.length) {
    fail(
      'PROPOSAL_CHANNEL_MISMATCH',
      'Proposal replacement item contains unsupported output variants.'
    );
  }
  if (
    !Array.isArray(raw.arrangement)
    || raw.arrangement.length !== cueCount - 1
  ) {
    fail(
      'CUE_COUNT_MISMATCH',
      'Proposal arrangement does not match the reviewed source cue count.'
    );
  }
  const arrangementIds = new Set();
  const arrangement = raw.arrangement.map((entry, index) => {
    exactKeys(
      entry,
      ['id', 'sectionId'],
      [],
      `Proposal arrangement entry ${index + 1}`,
      code
    );
    const normalized = {
      id: identifier(
        entry.id,
        `Proposal arrangement entry ${index + 1} id`,
        code
      ),
      sectionId: identifier(
        entry.sectionId,
        `Proposal arrangement entry ${index + 1} sectionId`,
        code
      )
    };
    if (arrangementIds.has(normalized.id)) {
      fail(code, 'Proposal arrangement repeats an entry id.');
    }
    arrangementIds.add(normalized.id);
    return normalized;
  });
  const primaryChannelId = identifier(
    raw.primaryChannelId,
    'Proposal replacement primaryChannelId',
    code
  );
  const primary = mappings.find(mapping =>
    mapping.channelId === primaryChannelId);
  if (
    primary?.mode !== 'content'
    || primary.songId !== reviewBinding.rootSongId
  ) {
    fail(
      'PROPOSAL_PRIMARY_CHANNEL_MISMATCH',
      'Proposal primary channel must directly use the reviewed family root.'
    );
  }
  if (
    raw.titlePresetId !== 'song-title'
    || raw.lyricsPresetId !== 'song-lyrics'
  ) {
    fail(code, 'Proposal replacement item uses unsupported native presets.');
  }
  const sourceRangeReplacement = normalizeSourceRangeReplacement(
    raw.sourceRangeReplacement,
    code
  );
  const expectedReceipt = {
    schemaVersion: SOURCE_RANGE_REPLACEMENT_SCHEMA_VERSION,
    kind: SOURCE_RANGE_REPLACEMENT_KIND,
    serviceSetId: projectBinding.serviceSet.id,
    serviceSetFingerprint: projectBinding.serviceSet.fingerprint,
    renderRevisionId: sourceRange.renderRevisionId,
    sourceProjectRevisionId: projectBinding.projectRevisionId,
    startPosition: sourceRange.startPosition,
    endPosition: sourceRange.endPosition,
    sourceItemIds: sourceRange.itemIds,
    sourceItemsSha256: canonicalHash(sourceRange.itemFingerprints),
    snapshotHash: reviewBinding.snapshotHash,
    receiptHash: reviewBinding.receiptHash,
    rootSongId: reviewBinding.rootSongId,
    familyRevision: reviewBinding.familyRevision
  };
  if (!canonicalEqual(sourceRangeReplacement, expectedReceipt)) {
    fail(
      'PROPOSAL_RECEIPT_MISMATCH',
      'Proposal source-range receipt does not match its exact evidence.'
    );
  }

  const resourcesBySongId = new Map(
    resources.map(resource => [resource.songId, resource])
  );
  const directSongIds = new Set();
  for (const mapping of mappings) {
    if (mapping.mode !== 'content') continue;
    directSongIds.add(mapping.songId);
    const resource = resourcesBySongId.get(mapping.songId);
    if (!resource || resource.revision !== mapping.songRevisionId) {
      fail(
        'PROPOSAL_RESOURCE_REVISION_MISMATCH',
        `Output ${mapping.channelId} does not have its exact proposal resource.`,
        { channelId: mapping.channelId, songId: mapping.songId }
      );
    }
  }
  if (
    resources.length !== directSongIds.size
    || resources.some(resource => !directSongIds.has(resource.songId))
  ) {
    fail(
      'PROPOSAL_RESOURCE_MISMATCH',
      'Proposal resources must cover exactly the direct song outputs.'
    );
  }
  const rootResource = resourcesBySongId.get(reviewBinding.rootSongId);
  if (!rootResource || item.title !== rootResource.document.title) {
    fail(
      'PROPOSAL_RESOURCE_MISMATCH',
      'Proposal replacement title does not match the reviewed family root.'
    );
  }
  for (const resource of resources) {
    const alignment = compareSongTranslations(
      rootResource.document,
      resource.document
    );
    if (!alignment.compatible) {
      fail(
        'SONG_STRUCTURE_MISMATCH',
        `Reviewed song ${resource.songId} cannot share one exact cue arrangement.`,
        { songId: resource.songId, ...alignment }
      );
    }
    for (const entry of arrangement) {
      const section = resource.document.sections.find(candidate =>
        candidate.id === entry.sectionId);
      if (!section || section.slides.length !== 1) {
        fail(
          'CUE_COUNT_MISMATCH',
          `Reviewed song ${resource.songId} section ${entry.sectionId} does not represent one source picture.`,
          { songId: resource.songId, sectionId: entry.sectionId }
        );
      }
    }
  }
  return {
    ...item,
    variants,
    arrangement,
    primaryChannelId,
    titlePresetId: 'song-title',
    lyricsPresetId: 'song-lyrics',
    sourceRangeReplacement
  };
}

function normalizeProposalBody(raw, { requireId = true } = {}) {
  const requiredKeys = [
    'schemaVersion',
    'kind',
    'createdAt',
    'projectBinding',
    'reviewBinding',
    'sourceRange',
    'channelMappings',
    'songResources',
    'replacementItem',
    'cueCount'
  ];
  if (requireId) requiredKeys.push('id');
  exactKeys(
    raw,
    requiredKeys,
    [],
    'Reviewed song range replacement proposal',
    'INVALID_REPLACEMENT_PROPOSAL'
  );
  if (
    raw.schemaVersion !== REVIEWED_SONG_RANGE_REPLACEMENT_SCHEMA_VERSION
    || raw.kind !== REVIEWED_SONG_RANGE_REPLACEMENT_KIND
  ) {
    fail(
      'INVALID_REPLACEMENT_PROPOSAL',
      'Reviewed song range replacement proposal uses an unsupported schema.'
    );
  }
  const createdAt = canonicalTimestamp(
    raw.createdAt,
    'Proposal createdAt',
    'INVALID_REPLACEMENT_PROPOSAL'
  );
  const projectBinding = normalizeProjectBinding(
    raw.projectBinding,
    'INVALID_REPLACEMENT_PROPOSAL'
  );
  const reviewBinding = normalizeReviewBinding(
    raw.reviewBinding,
    'INVALID_REPLACEMENT_PROPOSAL'
  );
  const sourceRange = normalizeSourceRange(
    raw.sourceRange,
    'INVALID_REPLACEMENT_PROPOSAL'
  );
  const { mappings } = normalizeChannelMappings(
    raw.channelMappings,
    projectBinding.channelIds,
    'INVALID_REPLACEMENT_PROPOSAL'
  );
  const resourceRecords = normalizeSongResources(
    raw.songResources,
    'INVALID_REPLACEMENT_PROPOSAL'
  );
  const cueCount = positiveInteger(
    raw.cueCount,
    'Proposal cueCount',
    MAX_SOURCE_RANGE_ITEMS,
    'INVALID_REPLACEMENT_PROPOSAL'
  );
  if (cueCount !== sourceRange.itemIds.length) {
    fail(
      'CUE_COUNT_MISMATCH',
      'Proposal cue count does not match the source picture range.'
    );
  }
  const songResources = resourceRecords.map(resource => ({
    songId: resource.songId,
    revision: resource.revision,
    documentSource: resource.documentSource
  }));
  const replacementItem = normalizeReplacementItem(
    raw.replacementItem,
    {
      createdAt,
      mappings,
      projectBinding,
      reviewBinding,
      sourceRange,
      resources: resourceRecords,
      cueCount
    },
    'INVALID_REPLACEMENT_PROPOSAL'
  );
  return {
    schemaVersion: REVIEWED_SONG_RANGE_REPLACEMENT_SCHEMA_VERSION,
    kind: REVIEWED_SONG_RANGE_REPLACEMENT_KIND,
    createdAt,
    projectBinding,
    reviewBinding,
    sourceRange,
    channelMappings: mappings,
    songResources,
    replacementItem,
    cueCount
  };
}

function normalizeReviewedSongRangeReplacementProposal(raw) {
  const body = normalizeProposalBody(raw);
  const expectedId = canonicalHash(body);
  if (raw.id !== expectedId) {
    fail(
      'PROPOSAL_HASH_MISMATCH',
      'Reviewed song range replacement proposal does not match its canonical hash.',
      { expectedId, actualId: raw.id || null }
    );
  }
  return deepFreeze({ ...body, id: expectedId });
}

function buildReviewedSongRangeReplacementProposal(options = {}) {
  exactKeys(options, [
    'project',
    'projectRevisionId',
    'reviewLookup',
    'channelMappings',
    'now'
  ], [], 'Reviewed song range replacement request', 'INVALID_REPLACEMENT_REQUEST');
  const project = canonicalProject(options.project);
  const projectRevisionId = digest(
    options.projectRevisionId,
    'Exact project revision id',
    'INVALID_REPLACEMENT_REQUEST'
  );
  const actualProjectRevisionId = serviceProjectRevisionId(project);
  if (projectRevisionId !== actualProjectRevisionId) {
    fail(
      'PROJECT_REVISION_MISMATCH',
      'The service project changed before reviewed song replacement.',
      { expected: projectRevisionId, actual: actualProjectRevisionId }
    );
  }
  if (!project.sourceServiceSet) {
    fail(
      'PROJECT_SERVICE_SET_REQUIRED',
      'Reviewed song replacement requires one exact project service-set binding.'
    );
  }
  const review = validateDurableReviewLookup(options.reviewLookup);
  if (!canonicalEqual(project.sourceServiceSet, review.serviceSet)) {
    fail(
      'SERVICE_SET_BINDING_MISMATCH',
      'The reviewed song family belongs to another exact service set.'
    );
  }
  const { mappings } = normalizeChannelMappings(
    options.channelMappings,
    project.channelIds,
    'INVALID_REPLACEMENT_REQUEST'
  );
  const contentMappings = mappings.filter(mapping =>
    mapping.mode === 'content');
  const primary = contentMappings.find(mapping =>
    mapping.songId === review.rootSongId);
  if (!primary) {
    fail(
      'ROOT_SONG_CHANNEL_REQUIRED',
      'At least one project output must directly use the reviewed family root.'
    );
  }
  const { positions } = exactReviewedPositions(review, contentMappings);
  const source = locateExactSourceRange(project, review.serviceSet, positions);

  const sourceItemIds = source.items.map(item => item.id);
  const itemFingerprints = source.items.map(item => ({
    itemId: item.id,
    fingerprint: canonicalHash(item)
  }));
  const createdAt = canonicalTimestamp(
    options.now instanceof Date ? options.now.toISOString() : options.now,
    'Replacement proposal time',
    'INVALID_REPLACEMENT_REQUEST'
  );
  const itemSeed = {
    projectId: project.id,
    projectRevisionId,
    snapshotHash: review.snapshotHash,
    receiptHash: review.receiptHash,
    familyRevision: review.familyRevision,
    sourceItemIds
  };
  const itemId = `song-range-${canonicalHash(itemSeed).slice(0, 40)}`;
  const arrangement = review.occurrences.map((occurrence, index) => ({
    id: `arr-${canonicalHash({
      familyRevision: review.familyRevision,
      occurrenceId: occurrence.occurrenceId,
      index
    }).slice(0, 32)}`,
    sectionId: occurrence.sectionId
  }));
  const directSongIds = [...new Set(contentMappings.map(mapping =>
    mapping.songId))].sort((left, right) => left.localeCompare(right, 'en'));
  const membersById = new Map(
    review.members.map(member => [member.songId, member])
  );
  const songResources = directSongIds.map(songId => {
    const member = membersById.get(songId);
    return {
      songId,
      revision: member.revision,
      documentSource: member.documentSource
    };
  });
  const sourceRange = {
    parentId: source.parentId,
    index: source.index,
    renderRevisionId: source.renderRevisionId,
    startPosition: positions[0],
    endPosition: positions.at(-1),
    itemIds: sourceItemIds,
    itemFingerprints
  };
  const projectBinding = {
    projectId: project.id,
    projectRevisionId,
    projectRevision: project.revision,
    updatedAt: project.updatedAt,
    channelIds: project.channelIds,
    serviceSet: project.sourceServiceSet
  };
  const reviewBinding = {
    snapshotHash: review.snapshotHash,
    receiptHash: review.receiptHash,
    rootSongId: review.rootSongId,
    familyRevision: review.familyRevision
  };
  const sourceRangeReplacement = {
    schemaVersion: SOURCE_RANGE_REPLACEMENT_SCHEMA_VERSION,
    kind: SOURCE_RANGE_REPLACEMENT_KIND,
    serviceSetId: review.serviceSet.id,
    serviceSetFingerprint: review.serviceSet.fingerprint,
    renderRevisionId: source.renderRevisionId,
    sourceProjectRevisionId: projectRevisionId,
    startPosition: positions[0],
    endPosition: positions.at(-1),
    sourceItemIds,
    sourceItemsSha256: canonicalHash(itemFingerprints),
    snapshotHash: review.snapshotHash,
    receiptHash: review.receiptHash,
    rootSongId: review.rootSongId,
    familyRevision: review.familyRevision
  };
  const replacementItem = {
    id: itemId,
    kind: 'song',
    title: review.root.document.title,
    createdAt,
    updatedAt: createdAt,
    operatorNotes: '',
    variants: Object.fromEntries(mappings.map(mapping => [
      mapping.channelId,
      variantFromMapping(mapping)
    ])),
    arrangement,
    primaryChannelId: primary.channelId,
    titlePresetId: 'song-title',
    lyricsPresetId: 'song-lyrics',
    sourceRangeReplacement
  };
  const body = normalizeProposalBody({
    schemaVersion: REVIEWED_SONG_RANGE_REPLACEMENT_SCHEMA_VERSION,
    kind: REVIEWED_SONG_RANGE_REPLACEMENT_KIND,
    createdAt,
    projectBinding,
    reviewBinding,
    sourceRange,
    channelMappings: mappings,
    songResources,
    replacementItem,
    cueCount: positions.length
  }, { requireId: false });
  return normalizeReviewedSongRangeReplacementProposal({
    ...body,
    id: canonicalHash(body)
  });
}

function assertCurrentProjectBinding(project, proposal) {
  if (
    project.id !== proposal.projectBinding.projectId
    || project.revision !== proposal.projectBinding.projectRevision
    || project.updatedAt !== proposal.projectBinding.updatedAt
    || !canonicalEqual(
      project.channelIds,
      proposal.projectBinding.channelIds
    )
    || !canonicalEqual(
      project.sourceServiceSet,
      proposal.projectBinding.serviceSet
    )
  ) {
    fail(
      'PROJECT_BINDING_MISMATCH',
      'The proposal belongs to another exact service project.'
    );
  }
  const actualRevisionId = serviceProjectRevisionId(project);
  if (actualRevisionId !== proposal.projectBinding.projectRevisionId) {
    fail(
      'PROJECT_REVISION_MISMATCH',
      'The service project changed after reviewed song replacement was proposed.',
      {
        expected: proposal.projectBinding.projectRevisionId,
        actual: actualRevisionId
      }
    );
  }
}

function assertCurrentSourceRange(project, proposal) {
  const source = proposal.sourceRange;
  const siblings = source.parentId === null
    ? project.rootItemIds
    : project.items[source.parentId]?.kind === 'group'
      ? project.items[source.parentId].childIds
      : null;
  if (
    !siblings
    || !canonicalEqual(
      siblings.slice(source.index, source.index + source.itemIds.length),
      source.itemIds
    )
  ) {
    fail(
      'SOURCE_RANGE_CHANGED',
      'The reviewed source pictures are no longer one exact contiguous range.'
    );
  }
  for (const [index, itemId] of source.itemIds.entries()) {
    const item = project.items[itemId];
    const expectedPosition = source.startPosition + index;
    if (
      !item
      || canonicalHash(item) !== source.itemFingerprints[index].fingerprint
      || !sourceVisualMatches(
        item,
        proposal.projectBinding.serviceSet,
        source.renderRevisionId,
        expectedPosition
      )
    ) {
      fail(
        'SOURCE_RANGE_CHANGED',
        `Reviewed source picture ${itemId} changed after proposal review.`,
        { itemId }
      );
    }
  }
}

function applyReviewedSongRangeReplacement(
  rawProject,
  rawProposal,
  options = {}
) {
  if (!isRecord(options) || options.confirmed !== true) {
    fail(
      'REPLACEMENT_CONFIRMATION_REQUIRED',
      'Reviewed song range replacement requires explicit operator confirmation.'
    );
  }
  const proposal = normalizeReviewedSongRangeReplacementProposal(rawProposal);
  const project = canonicalProject(rawProject);
  assertCurrentSourceRange(project, proposal);
  assertCurrentProjectBinding(project, proposal);

  let next = project;
  for (const resource of proposal.songResources) {
    const document = parseSongDocument(resource.documentSource, {
      fileName: `${resource.songId}.md`
    });
    const expectedResourceId = `sha256:${resource.revision}`;
    const existing = next.resources[expectedResourceId];
    if (existing) {
      if (
        existing.kind !== 'song'
        || existing.document.id !== resource.songId
        || existing.sha256 !== resource.revision
        || serializeSongDocument(existing.document) !== resource.documentSource
      ) {
        fail(
          'PROPOSAL_RESOURCE_REVISION_MISMATCH',
          `Existing song resource ${resource.songId} does not match the reviewed revision.`,
          { songId: resource.songId }
        );
      }
      continue;
    }
    const added = addSongResource(next, document, {
      provider: 'local-song-family-review',
      providerId: proposal.reviewBinding.receiptHash,
      itemId: resource.songId,
      revision: resource.revision
    });
    if (added.resourceId !== expectedResourceId) {
      fail(
        'PROPOSAL_RESOURCE_REVISION_MISMATCH',
        `Song resource ${resource.songId} changed before replacement.`,
        { songId: resource.songId }
      );
    }
    next = added.project;
  }
  if (typeof replaceProjectItemRange !== 'function') {
    fail(
      'RANGE_REPLACEMENT_UNAVAILABLE',
      'This SyncShow build does not yet support atomic project-item range replacement.'
    );
  }
  try {
    next = replaceProjectItemRange(next, proposal.replacementItem, {
      itemIds: proposal.sourceRange.itemIds,
      parentId: proposal.sourceRange.parentId,
      index: proposal.sourceRange.index,
      now: proposal.createdAt
    });
  } catch (error) {
    if (error instanceof ReviewedSongRangeReplacementError) throw error;
    fail(
      'RANGE_REPLACEMENT_FAILED',
      'The reviewed source picture range could not be replaced atomically.',
      { causeCode: error?.code || null }
    );
  }
  const replaced = next.items[proposal.replacementItem.id];
  if (
    !replaced
    || !canonicalEqual(
      replaced.sourceRangeReplacement,
      proposal.replacementItem.sourceRangeReplacement
    )
    || proposal.sourceRange.itemIds.some(itemId => next.items[itemId])
  ) {
    fail(
      'RANGE_REPLACEMENT_FAILED',
      'The atomic replacement did not preserve its exact source receipt.'
    );
  }
  let timeline;
  try {
    timeline = compileServiceProject(next);
  } catch (error) {
    fail(
      'CUE_COUNT_MISMATCH',
      'The replacement song could not compile into the reviewed cue range.',
      { causeCode: error?.code || null }
    );
  }
  const compiledCueCount = timeline.cueIds.filter(cueId =>
    timeline.cues[cueId].itemId === proposal.replacementItem.id).length;
  if (compiledCueCount !== proposal.cueCount) {
    fail(
      'CUE_COUNT_MISMATCH',
      'The replacement song cue count does not match the reviewed source range.',
      { expected: proposal.cueCount, actual: compiledCueCount }
    );
  }
  return deepFreeze({
    changed: true,
    project: next,
    proposalId: proposal.id,
    replacedItemIds: proposal.sourceRange.itemIds,
    replacementItemId: proposal.replacementItem.id,
    receipt: proposal.replacementItem.sourceRangeReplacement
  });
}

module.exports = {
  MAX_SOURCE_RANGE_ITEMS,
  REVIEWED_SONG_RANGE_REPLACEMENT_KIND,
  REVIEWED_SONG_RANGE_REPLACEMENT_SCHEMA_VERSION,
  ReviewedSongRangeReplacementError,
  SOURCE_RANGE_REPLACEMENT_KIND,
  SOURCE_RANGE_REPLACEMENT_SCHEMA_VERSION,
  applyReviewedSongRangeReplacement,
  buildReviewedSongRangeReplacementProposal,
  normalizeReviewedSongRangeReplacementProposal
};
