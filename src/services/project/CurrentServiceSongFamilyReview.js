'use strict';

const crypto = require('crypto');

const {
  applySongFamilyCaptureReview,
  createSongFamilyCaptureReview
} = require('./SongFamilyCaptureReview');
const {
  LocalServiceSongRightsEvidenceError,
  createLocalServiceSongRightsEvidence,
  normalizeLocalServiceSongRightsSelection
} = require('./LocalServiceSongRightsEvidence');
const {
  MAX_TOTAL_DOCUMENT_SOURCE_BYTES,
  SONG_FAMILY_REVIEW_CONFIRMATION_AUTHORITY_SCOPE,
  SONG_FAMILY_REVIEW_SCOPE,
  SONG_FAMILY_REVIEW_SNAPSHOT_KIND,
  SONG_FAMILY_REVIEW_SNAPSHOT_SCHEMA_VERSION
} = require('./LocalSongFamilyReviewStore');
const {
  MAX_SOURCE_BYTES,
  SongDocumentError,
  compareSongSections,
  normalizeSongDocument,
  parseSongDocument,
  serializeSongDocument
} = require('./SongDocument');
const {
  MAX_FAMILY_DOCUMENTS,
  compareCanonicalText
} = require('./SongFamilyRevision');

const CURRENT_SERVICE_SONG_FAMILY_REVIEW_SCHEMA_VERSION = 1;
const CURRENT_SERVICE_SONG_FAMILY_REVIEW_KIND =
  'syncshow-current-service-song-family-review';
const CURRENT_SERVICE_SONG_FAMILY_EXTRACTOR_ID =
  'syncshow-current-service-pptx';
const CURRENT_SERVICE_SONG_FAMILY_EXTRACTOR_VERSION = 1;
const CURRENT_SERVICE_SONG_FAMILY_MAX_PREVIEW_CHARS = 240;
const CURRENT_SERVICE_SONG_FAMILY_MAX_TITLE_EVIDENCE_CHARS = 32_000;
const CURRENT_SERVICE_SONG_FAMILY_MAX_CURRENT_SOURCE_BYTES =
  MAX_TOTAL_DOCUMENT_SOURCE_BYTES;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const LANGUAGE_PATTERN = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/;
const MEMBER_KEYS = Object.freeze(['root', 'translation']);
const LANE_IDS = Object.freeze(['all', 'white', 'yellow']);

class CurrentServiceSongFamilyReviewError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CurrentServiceSongFamilyReviewError';
    this.code = code;
    this.details = deepFreeze({ ...details });
  }
}

function fail(code, message, details = {}) {
  throw new CurrentServiceSongFamilyReviewError(code, message, details);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, keys, field) {
  if (!isRecord(value)) {
    fail('INVALID_CURRENT_SERVICE_SONG_FAMILY', `${field} must be an object.`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    fail(
      'INVALID_CURRENT_SERVICE_SONG_FAMILY',
      `${field} contains unsupported or missing fields.`
    );
  }
}

function reviewConfirmations(raw) {
  exactKeys(raw, [
    'sourceConfirmed',
    'rightsConfirmed',
    'localCommitConfirmed',
    'authorityScope',
    'communityAuthorityGranted'
  ], 'Song-family review confirmations');
  if (
    raw.sourceConfirmed !== true
    || raw.rightsConfirmed !== true
    || raw.localCommitConfirmed !== true
    || raw.authorityScope !==
      SONG_FAMILY_REVIEW_CONFIRMATION_AUTHORITY_SCOPE
    || raw.communityAuthorityGranted !== false
  ) {
    fail(
      'INVALID_CURRENT_SERVICE_SONG_FAMILY',
      'Song-family review confirmations must be explicit, local-only, and grant no Community authority.'
    );
  }
  return {
    sourceConfirmed: true,
    rightsConfirmed: true,
    localCommitConfirmed: true,
    authorityScope: SONG_FAMILY_REVIEW_CONFIRMATION_AUTHORITY_SCOPE,
    communityAuthorityGranted: false
  };
}

function identifier(value, field) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    fail(
      'INVALID_CURRENT_SERVICE_SONG_FAMILY',
      `${field} must be a canonical identifier.`
    );
  }
  return value;
}

function digest(value, field) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    fail(
      'INVALID_CURRENT_SERVICE_SONG_FAMILY',
      `${field} must be a lowercase SHA-256 digest.`
    );
  }
  return value;
}

function boundedText(
  value,
  field,
  maximum,
  { allowEmpty = false } = {}
) {
  if (
    typeof value !== 'string'
    || value !== value.trim()
    || (!allowEmpty && value.length < 1)
    || value.length > maximum
    || /[\0\r\n]/u.test(value)
  ) {
    fail(
      'INVALID_CURRENT_SERVICE_SONG_FAMILY',
      `${field} must be bounded one-line text.`
    );
  }
  return value;
}

function storedSongLanguage(value, field) {
  if (
    typeof value !== 'string'
    || value !== value.trim()
    || value.length < 1
    || value.length > 35
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    fail(
      'INVALID_CURRENT_SERVICE_SONG_FAMILY',
      `${field} must be bounded language text.`
    );
  }
  return value;
}

function canonicalTimestamp(value, field) {
  if (
    typeof value !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
    || Number.isNaN(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) {
    fail(
      'INVALID_CURRENT_SERVICE_SONG_FAMILY',
      `${field} must be a canonical UTC timestamp.`
    );
  }
  return value;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function slideLinesHash(lines) {
  return sha256(Buffer.from(JSON.stringify(lines), 'utf8'));
}

function orderedSlideLinesHash(slides) {
  return sha256(
    Buffer.from(JSON.stringify(slides.map(slide => slide.lines)), 'utf8')
  );
}

function songTextHash(song) {
  return orderedSlideLinesHash(
    song.sections.flatMap(section => section.slides)
  );
}

function sameLines(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((line, index) => line === right[index]);
}

function sameOccurrenceText(left, right, documentKeys) {
  return documentKeys.every(documentKey =>
    sameLines(
      left.linesByDocument[documentKey],
      right.linesByDocument[documentKey]
    ));
}

function normalizeServiceSet(raw) {
  exactKeys(
    raw,
    ['id', 'fingerprint', 'serviceDate', 'profileId', 'name'],
    'Current ServiceSet binding'
  );
  if (
    typeof raw.serviceDate !== 'string'
    || !/^\d{4}-\d{2}-\d{2}$/u.test(raw.serviceDate)
    || Number.isNaN(Date.parse(`${raw.serviceDate}T00:00:00.000Z`))
    || new Date(`${raw.serviceDate}T00:00:00.000Z`)
      .toISOString()
      .slice(0, 10) !== raw.serviceDate
  ) {
    fail(
      'INVALID_CURRENT_SERVICE_SONG_FAMILY',
      'Current ServiceSet date is invalid.'
    );
  }
  return {
    id: identifier(raw.id, 'Current ServiceSet id'),
    fingerprint: digest(raw.fingerprint, 'Current ServiceSet fingerprint'),
    serviceDate: raw.serviceDate,
    profileId: identifier(raw.profileId, 'Current ServiceSet profile'),
    name: boundedText(raw.name, 'Current ServiceSet name', 300)
  };
}

function normalizeSlideLines(lines, field) {
  if (
    !Array.isArray(lines)
    || lines.length < 1
    || lines.length > 10_000
  ) {
    fail(
      'INVALID_CURRENT_SERVICE_SONG_FAMILY',
      `${field} must contain captured lyric lines.`
    );
  }
  let hasText = false;
  const normalized = lines.map((line, index) => {
    if (
      typeof line !== 'string'
      || line.length > 1_000
      || /[\0\r\n]/u.test(line)
    ) {
      fail(
        'INVALID_CURRENT_SERVICE_SONG_FAMILY',
        `${field} line ${index + 1} is invalid.`
      );
    }
    if (line.length > 0) hasText = true;
    return line;
  });
  if (!hasText) {
    fail(
      'INVALID_CURRENT_SERVICE_SONG_FAMILY',
      `${field} cannot be entirely empty.`
    );
  }
  return normalized;
}

function normalizeTitleCardEvidence(
  raw,
  memberKey,
  selectionOrigin,
  titleSlide
) {
  exactKeys(raw, [
    'kind',
    'slideNumber',
    'lines'
  ], `Captured family member ${memberKey} title-card evidence`);
  if (selectionOrigin === 'manual') {
    if (
      raw.kind !== 'none'
      || raw.slideNumber !== null
      || !Array.isArray(raw.lines)
      || raw.lines.length !== 0
    ) {
      fail(
        'INVALID_CURRENT_SERVICE_SONG_FAMILY',
        `Manual family member ${memberKey} cannot claim title-card evidence.`
      );
    }
    return {
      kind: 'none',
      slideNumber: null,
      lines: []
    };
  }
  if (
    raw.kind !== 'template-local'
    || raw.slideNumber !== titleSlide
  ) {
    fail(
      'INVALID_CURRENT_SERVICE_SONG_FAMILY',
      `Template family member ${memberKey} must bind its exact title-card slide.`
    );
  }
  const lines = normalizeSlideLines(
    raw.lines,
    `Captured family member ${memberKey} title-card evidence`
  );
  if (
    lines.reduce((sum, line) => sum + line.length, 0)
      > CURRENT_SERVICE_SONG_FAMILY_MAX_TITLE_EVIDENCE_CHARS
  ) {
    fail(
      'CURRENT_SERVICE_SONG_FAMILY_TOO_LARGE',
      `Captured family member ${memberKey} title-card evidence is too large.`
    );
  }
  return {
    kind: 'template-local',
    slideNumber: titleSlide,
    lines
  };
}

function normalizeMember(raw, index) {
  exactKeys(raw, [
    'memberKey',
    'songId',
    'title',
    'language',
    'source',
    'selection',
    'titleCardEvidence',
    'draft'
  ], `Captured family member ${index + 1}`);
  exactKeys(raw.source, [
    'roleId',
    'roleLabel',
    'fileName',
    'sourceSizeBytes',
    'deckSha256',
    'deckSlideCount',
    'sourceLabel'
  ], `Captured family member ${index + 1} source`);
  exactKeys(raw.selection, [
    'selectionOrigin',
    'candidateId',
    'titleSlide',
    'slideNumbers',
    'slideLanes'
  ], `Captured family member ${index + 1} selection`);
  if (!MEMBER_KEYS.includes(raw.memberKey)) {
    fail(
      'INVALID_CURRENT_SERVICE_SONG_FAMILY',
      'Captured memberKey must be root or translation.'
    );
  }
  if (
    typeof raw.language !== 'string'
    || !LANGUAGE_PATTERN.test(raw.language)
  ) {
    fail(
      'INVALID_CURRENT_SERVICE_SONG_FAMILY',
      `Captured family member ${raw.memberKey} language is invalid.`
    );
  }
  const fileName = boundedText(
    raw.source.fileName,
    `Captured family member ${raw.memberKey} file name`,
    255
  );
  if (
    fileName.includes('/')
    || fileName.includes('\\')
    || fileName === '.'
    || fileName === '..'
  ) {
    fail(
      'INVALID_CURRENT_SERVICE_SONG_FAMILY',
      'Captured source file name must be path-free.'
    );
  }
  if (
    !Number.isSafeInteger(raw.source.sourceSizeBytes)
    || raw.source.sourceSizeBytes < 1
    || raw.source.sourceSizeBytes > 128 * 1024 * 1024
    || !Number.isSafeInteger(raw.source.deckSlideCount)
    || raw.source.deckSlideCount < 1
    || raw.source.deckSlideCount > 1_000
  ) {
    fail(
      'INVALID_CURRENT_SERVICE_SONG_FAMILY',
      `Captured family member ${raw.memberKey} source bounds are invalid.`
    );
  }
  if (
    !Array.isArray(raw.selection.slideNumbers)
    || raw.selection.slideNumbers.length < 1
    || raw.selection.slideNumbers.length > 200
    || !Array.isArray(raw.selection.slideLanes)
    || raw.selection.slideLanes.length !== raw.selection.slideNumbers.length
  ) {
    fail(
      'INVALID_CURRENT_SERVICE_SONG_FAMILY',
      `Captured family member ${raw.memberKey} slide selection is invalid.`
    );
  }
  const slideNumbers = raw.selection.slideNumbers.map((number, slideIndex) => {
    if (
      !Number.isSafeInteger(number)
      || number < 1
      || number > raw.source.deckSlideCount
      || (slideIndex > 0 && number <= raw.selection.slideNumbers[slideIndex - 1])
    ) {
      fail(
        'INVALID_CURRENT_SERVICE_SONG_FAMILY',
        `Captured family member ${raw.memberKey} slide order is invalid.`
      );
    }
    return number;
  });
  const slideLanes = raw.selection.slideLanes.map(lane => {
    if (!LANE_IDS.includes(lane)) {
      fail(
        'INVALID_CURRENT_SERVICE_SONG_FAMILY',
        `Captured family member ${raw.memberKey} lane is invalid.`
      );
    }
    return lane;
  });
  const selectionOrigin = raw.selection.selectionOrigin;
  if (!['template-local', 'manual'].includes(selectionOrigin)) {
    fail(
      'INVALID_CURRENT_SERVICE_SONG_FAMILY',
      `Captured family member ${raw.memberKey} selection origin is invalid.`
    );
  }
  let candidateId = null;
  let titleSlide = null;
  if (selectionOrigin === 'template-local') {
    candidateId = boundedText(
      raw.selection.candidateId,
      `Captured family member ${raw.memberKey} candidate`,
      128
    );
    titleSlide = raw.selection.titleSlide;
    const candidateMatch =
      /^slides-(\d{1,4})-(\d{1,4})-(\d{1,4})$/u.exec(candidateId);
    if (
      !candidateMatch
      || !Number.isSafeInteger(titleSlide)
      || titleSlide < 1
      || Number.parseInt(candidateMatch[1], 10) !== titleSlide
      || Number.parseInt(candidateMatch[2], 10) !== slideNumbers[0]
      || Number.parseInt(candidateMatch[3], 10)
        !== slideNumbers[slideNumbers.length - 1]
      || slideNumbers[0] !== titleSlide + 1
      || slideNumbers.some((number, slideIndex) =>
        number !== slideNumbers[0] + slideIndex)
    ) {
      fail(
        'INVALID_CURRENT_SERVICE_SONG_FAMILY',
        `Captured family member ${raw.memberKey} candidate evidence is invalid.`
      );
    }
  } else if (
    raw.selection.candidateId !== null
    || raw.selection.titleSlide !== null
  ) {
    fail(
      'INVALID_CURRENT_SERVICE_SONG_FAMILY',
      'Manual family capture cannot claim a template candidate.'
    );
  }
  const titleCardEvidence = normalizeTitleCardEvidence(
    raw.titleCardEvidence,
    raw.memberKey,
    selectionOrigin,
    titleSlide
  );
  if (
    !isRecord(raw.draft)
    || !isRecord(raw.draft.song)
    || !isRecord(raw.draft.provenance)
    || !Array.isArray(raw.draft.warnings)
    || raw.draft.song.sections?.length !== slideNumbers.length
    || raw.draft.provenance.deckSha256 !== raw.source.deckSha256
    || raw.draft.provenance.deckSlideCount !== raw.source.deckSlideCount
    || JSON.stringify(raw.draft.provenance.slideNumbers)
      !== JSON.stringify(slideNumbers)
    || JSON.stringify(raw.draft.provenance.slideLanes)
      !== JSON.stringify(slideLanes)
  ) {
    fail(
      'INVALID_CURRENT_SERVICE_SONG_FAMILY',
      `Captured family member ${raw.memberKey} draft provenance is inconsistent.`
    );
  }
  const slideLines = raw.draft.song.sections.map((section, slideIndex) =>
    normalizeSlideLines(
      section?.slides?.[0]?.lines,
      `Captured family member ${raw.memberKey} slide ${slideNumbers[slideIndex]}`
    ));
  return {
    memberKey: raw.memberKey,
    songId: identifier(
      raw.songId,
      `Captured family member ${raw.memberKey} song id`
    ),
    title: boundedText(
      raw.title,
      `Captured family member ${raw.memberKey} title`,
      200
    ),
    language: raw.language,
    source: {
      roleId: identifier(
        raw.source.roleId,
        `Captured family member ${raw.memberKey} role`
      ),
      roleLabel: boundedText(
        raw.source.roleLabel,
        `Captured family member ${raw.memberKey} role label`,
        120
      ),
      fileName,
      sourceSizeBytes: raw.source.sourceSizeBytes,
      deckSha256: digest(
        raw.source.deckSha256,
        `Captured family member ${raw.memberKey} deck digest`
      ),
      deckSlideCount: raw.source.deckSlideCount,
      sourceLabel: boundedText(
        raw.source.sourceLabel,
        `Captured family member ${raw.memberKey} source label`,
        500
      )
    },
    selection: {
      selectionOrigin,
      candidateId,
      titleSlide,
      slideNumbers,
      slideLanes
    },
    titleCardEvidence,
    slideLines,
    warnings: raw.draft.warnings.map((warning, warningIndex) => {
      if (!isRecord(warning)) {
        fail(
          'INVALID_CURRENT_SERVICE_SONG_FAMILY',
          `Captured warning ${warningIndex + 1} is invalid.`
        );
      }
      return {
        code: boundedText(
          warning.code,
          `Captured warning ${warningIndex + 1} code`,
          128
        ),
        message: boundedText(
          warning.message,
          `Captured warning ${warningIndex + 1} message`,
          1_000
        )
      };
    })
  };
}

function normalizeCurrentDocuments(rawDocuments, rootSongId, capturedSongIds) {
  if (!Array.isArray(rawDocuments) || rawDocuments.length > 10_000) {
    fail(
      'INVALID_CURRENT_SERVICE_SONG_FAMILY',
      'Current song-library snapshot is invalid.'
    );
  }
  let aggregateSourceBytes = 0;
  for (const raw of rawDocuments) {
    if (typeof raw?.documentSource !== 'string') continue;
    aggregateSourceBytes += Buffer.byteLength(raw.documentSource, 'utf8');
    if (
      aggregateSourceBytes
      > CURRENT_SERVICE_SONG_FAMILY_MAX_CURRENT_SOURCE_BYTES
        + (2 * 512 * 1024)
    ) {
      fail(
        'CURRENT_SERVICE_SONG_FAMILY_TOO_LARGE',
        'The current song-family review input is too large to inspect safely.'
      );
    }
  }
  const byId = new Map();
  for (const [index, raw] of rawDocuments.entries()) {
    if (
      !isRecord(raw)
      || !isRecord(raw.song)
      || typeof raw.documentSource !== 'string'
      || typeof raw.revision !== 'string'
    ) {
      fail(
        'INVALID_CURRENT_SERVICE_SONG_FAMILY',
        `Current song-library member ${index + 1} is invalid.`
      );
    }
    const songId = identifier(raw.song.id, 'Current song id');
    if (
      byId.has(songId)
      || digest(raw.revision, `Current song ${songId} revision`)
        !== sha256(Buffer.from(raw.documentSource, 'utf8'))
    ) {
      fail(
        'INVALID_CURRENT_SERVICE_SONG_FAMILY',
        'Current song-library identities or revisions are inconsistent.'
      );
    }
    let song;
    try {
      song = parseSongDocument(raw.documentSource, {
        fileName: `${songId}.md`
      });
    } catch (_error) {
      fail(
        'INVALID_CURRENT_SERVICE_SONG_FAMILY',
        `Current song ${songId} is not canonical.`
      );
    }
    if (
      song.id !== songId
      || serializeSongDocument(song) !== raw.documentSource
    ) {
      fail(
        'INVALID_CURRENT_SERVICE_SONG_FAMILY',
        `Current song ${songId} is not canonical.`
      );
    }
    byId.set(songId, {
      song,
      documentSource: raw.documentSource,
      revision: raw.revision
    });
  }

  const existingRoot = byId.get(rootSongId);
  if (existingRoot?.song.translationOf) {
    fail(
      'CURRENT_SERVICE_SONG_FAMILY_ROOT_CONFLICT',
      'The chosen root song is currently saved as a translation.',
      {
        songId: rootSongId,
        currentFamilyId: existingRoot.song.translationOf
      }
    );
  }
  for (const songId of capturedSongIds) {
    const existing = byId.get(songId);
    if (
      existing
      && songId !== rootSongId
      && existing.song.translationOf !== rootSongId
    ) {
      fail(
        'CURRENT_SERVICE_SONG_FAMILY_ID_CONFLICT',
        `Song ${songId} already belongs to another saved family.`,
        {
          songId,
          currentFamilyId: existing.song.translationOf || existing.song.id
        }
      );
    }
  }
  const family = [...byId.values()]
    .filter(current =>
      current.song.id === rootSongId
      || current.song.translationOf === rootSongId)
    .sort((left, right) =>
      Number(Boolean(left.song.translationOf))
        - Number(Boolean(right.song.translationOf))
      || compareCanonicalText(left.song.id, right.song.id));
  if (family.length > 0 && family[0].song.id !== rootSongId) {
    fail(
      'CURRENT_SERVICE_SONG_FAMILY_ROOT_MISSING',
      'Saved translations exist without their exact family root.'
    );
  }
  const totalBytes = family.reduce(
    (sum, member) =>
      sum + Buffer.byteLength(member.documentSource, 'utf8'),
    0
  );
  if (totalBytes > CURRENT_SERVICE_SONG_FAMILY_MAX_CURRENT_SOURCE_BYTES) {
    fail(
      'CURRENT_SERVICE_SONG_FAMILY_TOO_LARGE',
      'The complete current song family is too large to review atomically.'
    );
  }
  return family;
}

function reviewSourceDigest(serviceSet, members) {
  return sha256(Buffer.from(JSON.stringify({
    serviceSet: {
      id: serviceSet.id,
      fingerprint: serviceSet.fingerprint,
      serviceDate: serviceSet.serviceDate,
      profileId: serviceSet.profileId
    },
    members: members.map(member => ({
      memberKey: member.memberKey,
      songId: member.songId,
      roleId: member.source.roleId,
      deckSha256: member.source.deckSha256,
      slideNumbers: member.selection.slideNumbers,
      slideLanes: member.selection.slideLanes
    }))
  }), 'utf8'));
}

function safeDefaultReview(capture) {
  const created = createSongFamilyCaptureReview(capture, {
    rootDocumentKey: 'root'
  });
  const documentKeys = capture.documents.map(document => document.key);
  const prior = [];
  const decisions = capture.occurrences.map((occurrence, index) => {
    const repeated = prior.find(candidate =>
      sameOccurrenceText(occurrence, candidate, documentKeys));
    prior.push(occurrence);
    if (!repeated) return { ...created.decisions[index] };
    return {
      occurrenceId: occurrence.occurrenceId,
      action: 'repeat',
      repeatOfOccurrenceId: repeated.occurrenceId,
      note:
        `Safe default: exact all-language repeat of ${repeated.occurrenceId}.`
    };
  });
  const review = {
    schemaVersion: created.schemaVersion,
    kind: created.kind,
    captureFingerprint: created.captureFingerprint,
    rootDocumentKey: created.rootDocumentKey,
    decisions
  };
  const applied = applySongFamilyCaptureReview(capture, review);
  if (applied.status !== 'ready') {
    fail(
      'CURRENT_SERVICE_SONG_FAMILY_NEEDS_PAIRING',
      'Every included occurrence must contain text for every captured member.'
    );
  }
  return deepFreeze(review);
}

function boundedPreview(lines) {
  const full = lines.join('\n').replace(/\0/gu, '');
  if (full.length <= CURRENT_SERVICE_SONG_FAMILY_MAX_PREVIEW_CHARS) {
    return full;
  }
  let prefix = full.slice(
    0,
    CURRENT_SERVICE_SONG_FAMILY_MAX_PREVIEW_CHARS - 1
  );
  if (/[\uD800-\uDBFF]$/u.test(prefix)) prefix = prefix.slice(0, -1);
  return `${prefix}…`;
}

function publicRightsMetadata(song) {
  return {
    license: song?.license || '',
    attribution: song?.attribution || '',
    tags: [...(song?.tags || [])],
    authors: [...(song?.authors || [])],
    translators: [...(song?.translators || [])],
    composers: [...(song?.composers || [])]
  };
}

function publicCurrentIdentity(current) {
  const slides = current.song.sections.flatMap(section => section.slides);
  return {
    songId: current.song.id,
    revision: current.revision,
    title: current.song.title,
    language: storedSongLanguage(
      current.song.language,
      `Current song ${current.song.id} language`
    ),
    translationOf: current.song.translationOf,
    sectionCount: current.song.sections.length,
    slideCount: slides.length,
    lineCount: slides.reduce(
      (sum, slide) => sum + slide.lines.length,
      0
    ),
    metadata: publicRightsMetadata(current.song)
  };
}

function assertProspectiveFamilyCapacity(
  members,
  currentFamily,
  { exactDocuments = null } = {}
) {
  const capturedSongIds = new Set(members.map(member => member.songId));
  const retainedCurrent = currentFamily.filter(current =>
    !capturedSongIds.has(current.song.id));
  const memberCount = exactDocuments === null
    ? retainedCurrent.length + members.length
    : exactDocuments.length;
  if (memberCount > MAX_FAMILY_DOCUMENTS) {
    fail(
      'CURRENT_SERVICE_SONG_FAMILY_MEMBER_LIMIT',
      `This local song family would contain more than ${MAX_FAMILY_DOCUMENTS} members. Remove or replace a saved translation before adding another.`
    );
  }

  const totalSourceBytes = exactDocuments === null
    ? retainedCurrent.reduce(
        (sum, current) =>
          sum + Buffer.byteLength(current.documentSource, 'utf8'),
        0
      ) + (members.length * MAX_SOURCE_BYTES)
    : exactDocuments.reduce(
        (sum, document) =>
          sum + Buffer.byteLength(document.documentSource, 'utf8'),
        0
      );
  if (totalSourceBytes > MAX_TOTAL_DOCUMENT_SOURCE_BYTES) {
    fail(
      'CURRENT_SERVICE_SONG_FAMILY_SOURCE_LIMIT',
      exactDocuments === null
        ? 'This local song family is too large to reserve safe space for every reviewed document. Remove or replace a saved translation before continuing.'
        : 'The reviewed local song family exceeds its total source limit. Shorten the reviewed metadata or remove a saved translation before saving.'
    );
  }
}

function publicSummary(members, currentFamily, capture, review) {
  const membersByKey = new Map(members.map(member => [
    member.memberKey,
    member
  ]));
  const currentById = new Map(
    currentFamily.map(current => [current.song.id, current])
  );
  const capturedSongIds = new Set(members.map(member => member.songId));
  const warnings = [];
  const seenWarnings = new Set();
  for (const member of members) {
    for (const warning of member.warnings) {
      const key = `${warning.code}\0${warning.message}`;
      if (seenWarnings.has(key)) continue;
      seenWarnings.add(key);
      warnings.push({ ...warning });
    }
  }
  return {
    family: {
      rootSongId: membersByKey.get('root').songId,
      members: members.map(member => {
        const current = currentById.get(member.songId);
        return {
          memberKey: member.memberKey,
          songId: member.songId,
          title: member.title,
          language: member.language,
          familyRole: member.memberKey,
          source: {
            roleId: member.source.roleId,
            roleLabel: member.source.roleLabel,
            fileName: member.source.fileName
          },
          slideCount: member.selection.slideNumbers.length,
          saveDisposition: current ? 'existing-may-update' : 'create',
          currentIdentity: current
            ? publicCurrentIdentity(current)
            : null,
          titleCardEvidence: {
            kind: member.titleCardEvidence.kind,
            slideNumber: member.titleCardEvidence.slideNumber,
            lines: [...member.titleCardEvidence.lines]
          },
          metadata: publicRightsMetadata(current?.song)
        };
      })
    },
    retainedTranslations: currentFamily
      .filter(current =>
        current.song.translationOf === membersByKey.get('root').songId
        && !capturedSongIds.has(current.song.id))
      .map(publicCurrentIdentity),
    occurrences: capture.occurrences.map((occurrence, index) => ({
      occurrenceId: occurrence.occurrenceId,
      ordinal: index + 1,
      members: members.map(member => ({
        memberKey: member.memberKey,
        slideNumber: member.selection.slideNumbers[index],
        lane: member.selection.slideLanes[index],
        preview: boundedPreview(
          occurrence.linesByDocument[member.memberKey]
        ),
        lines: [...occurrence.linesByDocument[member.memberKey]]
      })),
      suggestedDecision: { ...review.decisions[index] }
    })),
    warnings,
    confirmations: {
      sourceRequired: true,
      rightsRequired: true,
      localCommitRequired: true
    }
  };
}

function createCurrentServiceSongFamilyReview(raw = {}) {
  exactKeys(
    raw,
    ['serviceSet', 'members', 'currentDocuments'],
    'Current service song-family review'
  );
  const serviceSet = normalizeServiceSet(raw.serviceSet);
  if (
    !Array.isArray(raw.members)
    || raw.members.length < 1
    || raw.members.length > 2
  ) {
    fail(
      'INVALID_CURRENT_SERVICE_SONG_FAMILY',
      'Capture exactly one root and at most one translation.'
    );
  }
  const members = raw.members.map(normalizeMember);
  if (
    members[0].memberKey !== 'root'
    || (members.length === 2 && members[1].memberKey !== 'translation')
    || new Set(members.map(member => member.songId)).size !== members.length
    || new Set(members.map(member => member.language)).size !== members.length
  ) {
    fail(
      'INVALID_CURRENT_SERVICE_SONG_FAMILY',
      'Captured family members must be one ordered root and one optional translation with distinct identities and languages.'
    );
  }
  const occurrenceCount = members[0].selection.slideNumbers.length;
  if (members.some(member =>
    member.selection.slideNumbers.length !== occurrenceCount)) {
    fail(
      'CURRENT_SERVICE_SONG_FAMILY_OCCURRENCE_COUNT_MISMATCH',
      'Root and translation selections must contain the same number of lyric occurrences.'
    );
  }
  if (
    members.length === 2
    && members[0].source.deckSha256 === members[1].source.deckSha256
    && JSON.stringify(members[0].selection.slideNumbers)
      !== JSON.stringify(members[1].selection.slideNumbers)
  ) {
    fail(
      'CURRENT_SERVICE_SONG_FAMILY_SHARED_DECK_RANGE_MISMATCH',
      'Two language lanes from one deck must use the same exact slide range.'
    );
  }
  const currentFamily = normalizeCurrentDocuments(
    raw.currentDocuments,
    members[0].songId,
    members.map(member => member.songId)
  );
  assertProspectiveFamilyCapacity(members, currentFamily);
  const sourceLabel = boundedText(
    `${serviceSet.name} (${serviceSet.serviceDate})`,
    'Current service song-family source label',
    500
  );
  const capture = {
    schemaVersion: CURRENT_SERVICE_SONG_FAMILY_REVIEW_SCHEMA_VERSION,
    kind: 'syncshow-song-family-capture',
    source: {
      label: sourceLabel,
      sha256: reviewSourceDigest(serviceSet, members)
    },
    documents: members.map(member => ({
      key: member.memberKey,
      id: member.songId,
      title: member.title,
      language: member.language
    })),
    occurrences: Array.from({ length: occurrenceCount }, (_value, index) => ({
      occurrenceId: `occurrence-${index + 1}`,
      sourceLabel: `Service occurrence ${index + 1}`,
      linesByDocument: Object.fromEntries(
        members.map(member => [
          member.memberKey,
          member.slideLines[index]
        ])
      )
    }))
  };
  const review = safeDefaultReview(capture);
  return deepFreeze({
    schemaVersion: CURRENT_SERVICE_SONG_FAMILY_REVIEW_SCHEMA_VERSION,
    kind: CURRENT_SERVICE_SONG_FAMILY_REVIEW_KIND,
    serviceSet,
    members,
    currentFamily,
    capture,
    review,
    summary: publicSummary(members, currentFamily, capture, review)
  });
}

function normalizedList(value, field) {
  if (!Array.isArray(value) || value.length > 64) {
    fail(
      'INVALID_CURRENT_SERVICE_SONG_FAMILY_METADATA',
      `${field} must contain at most 64 values.`
    );
  }
  const result = [];
  const seen = new Set();
  for (const [index, raw] of value.entries()) {
    if (typeof raw !== 'string') {
      fail(
        'INVALID_CURRENT_SERVICE_SONG_FAMILY_METADATA',
        `${field} value ${index + 1} must be text.`
      );
    }
    const item = raw.trim();
    if (item.length > 120 || /[\0\r\n]/u.test(item)) {
      fail(
        'INVALID_CURRENT_SERVICE_SONG_FAMILY_METADATA',
        `${field} value ${index + 1} is too long or contains a line break.`
      );
    }
    const key = item.toLowerCase();
    if (!item || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function localServiceRightsSelection(value) {
  try {
    return normalizeLocalServiceSongRightsSelection(value);
  } catch (error) {
    if (error instanceof LocalServiceSongRightsEvidenceError) {
      fail(
        'INVALID_CURRENT_SERVICE_SONG_FAMILY_METADATA',
        error.message
      );
    }
    throw error;
  }
}

function localServiceRightsEvidence(value, reviewedAt) {
  try {
    return createLocalServiceSongRightsEvidence(value, { reviewedAt });
  } catch (error) {
    if (error instanceof LocalServiceSongRightsEvidenceError) {
      fail(
        'INVALID_CURRENT_SERVICE_SONG_FAMILY_REVIEW',
        error.message
      );
    }
    throw error;
  }
}

function normalizeMetadata(rawMetadata, members) {
  if (
    !Array.isArray(rawMetadata)
    || rawMetadata.length !== members.length
  ) {
    fail(
      'INVALID_CURRENT_SERVICE_SONG_FAMILY_METADATA',
      'Provide metadata for every captured family member.'
    );
  }
  const byKey = new Map();
  for (const [index, raw] of rawMetadata.entries()) {
    exactKeys(raw, [
      'memberKey',
      'license',
      'attribution',
      'tags',
      'authors',
      'translators',
      'composers',
      'localServiceRights'
    ], `Song-family metadata ${index + 1}`);
    if (
      !members.some(member => member.memberKey === raw.memberKey)
      || byKey.has(raw.memberKey)
    ) {
      fail(
        'INVALID_CURRENT_SERVICE_SONG_FAMILY_METADATA',
        'Song-family metadata member keys are invalid or duplicated.'
      );
    }
    byKey.set(raw.memberKey, {
      memberKey: raw.memberKey,
      license: boundedText(
        raw.license,
        `Song-family ${raw.memberKey} license`,
        300
      ),
      attribution: boundedText(
        raw.attribution,
        `Song-family ${raw.memberKey} attribution`,
        2_048,
        { allowEmpty: true }
      ),
      tags: normalizedList(raw.tags, `Song-family ${raw.memberKey} tags`),
      authors: normalizedList(
        raw.authors,
        `Song-family ${raw.memberKey} authors`
      ),
      translators: normalizedList(
        raw.translators,
        `Song-family ${raw.memberKey} translators`
      ),
      composers: normalizedList(
        raw.composers,
        `Song-family ${raw.memberKey} composers`
      ),
      localServiceRights: localServiceRightsSelection(
        raw.localServiceRights
      )
    });
  }
  return members.map(member => byKey.get(member.memberKey));
}

function applyCurrentServiceSongFamilyReview(
  prepared,
  { decisions, metadata } = {}
) {
  if (
    !isRecord(prepared)
    || prepared.kind !== CURRENT_SERVICE_SONG_FAMILY_REVIEW_KIND
    || !Array.isArray(decisions)
    || decisions.length !== prepared.capture.occurrences.length
  ) {
    fail(
      'INVALID_CURRENT_SERVICE_SONG_FAMILY_REVIEW',
      'Song-family occurrence decisions must cover the held capture exactly.'
    );
  }
  const rawReview = {
    schemaVersion: prepared.review.schemaVersion,
    kind: prepared.review.kind,
    captureFingerprint: prepared.review.captureFingerprint,
    rootDocumentKey: prepared.review.rootDocumentKey,
    decisions
  };
  let result;
  try {
    result = applySongFamilyCaptureReview(prepared.capture, rawReview);
  } catch (error) {
    if (error instanceof CurrentServiceSongFamilyReviewError) throw error;
    fail(
      error?.code || 'INVALID_CURRENT_SERVICE_SONG_FAMILY_REVIEW',
      error?.message || 'Song-family occurrence decisions are invalid.',
      error?.details || {}
    );
  }
  if (result.status !== 'ready') {
    fail(
      'CURRENT_SERVICE_SONG_FAMILY_NOT_READY',
      'Keep at least one complete new occurrence before committing this family.'
    );
  }
  const normalizedMetadata = normalizeMetadata(metadata, prepared.members);
  const metadataByKey = new Map(
    normalizedMetadata.map(item => [item.memberKey, item])
  );
  const documentsByKey = new Map();
  for (const rawDocument of result.documents) {
    const member = prepared.members.find(candidate =>
      candidate.songId === rawDocument.id);
    const memberMetadata = metadataByKey.get(member.memberKey);
    let song;
    let documentSource;
    let canonical;
    try {
      song = normalizeSongDocument({
        ...rawDocument,
        license: memberMetadata.license,
        attribution: memberMetadata.attribution,
        tags: memberMetadata.tags,
        authors: memberMetadata.authors,
        translators: memberMetadata.translators,
        composers: memberMetadata.composers
      });
      documentSource = serializeSongDocument(song);
      canonical = parseSongDocument(documentSource, {
        fileName: `${song.id}.md`
      });
    } catch (error) {
      if (
        error instanceof SongDocumentError
        && error.code === 'SOURCE_TOO_LARGE'
      ) {
        fail(
          'CURRENT_SERVICE_SONG_FAMILY_SOURCE_LIMIT',
          `The reviewed ${member.memberKey} song exceeds its source limit. Shorten its metadata before saving.`
        );
      }
      throw error;
    }
    documentsByKey.set(member.memberKey, {
      song: canonical,
      documentSource,
      revision: sha256(Buffer.from(documentSource, 'utf8')),
      localServiceRightsSelection: memberMetadata.localServiceRights
    });
  }
  return deepFreeze({
    result,
    documentsByKey: Object.fromEntries(documentsByKey)
  });
}

function memberCapture(member) {
  const slides = member.selection.slideNumbers.map((number, index) => ({
    number,
    lane: member.selection.slideLanes[index],
    lines: member.slideLines[index],
    textSha256: slideLinesHash(member.slideLines[index])
  }));
  return {
    ordinal: 1,
    roleId: member.source.roleId,
    deckSha256: member.source.deckSha256,
    selectionOrigin: member.selection.selectionOrigin,
    candidateId: member.selection.candidateId,
    titleSlide: member.selection.titleSlide,
    capturedTextSha256: orderedSlideLinesHash(slides),
    slides
  };
}

function currentServiceSongFamilyReviewSnapshot(
  prepared,
  applied,
  { reviewedAt, confirmations } = {}
) {
  if (
    !isRecord(prepared)
    || prepared.kind !== CURRENT_SERVICE_SONG_FAMILY_REVIEW_KIND
    || !isRecord(applied)
    || !isRecord(applied.documentsByKey)
  ) {
    fail(
      'INVALID_CURRENT_SERVICE_SONG_FAMILY_REVIEW',
      'The held song-family review result is invalid.'
    );
  }
  const exactReviewedAt = canonicalTimestamp(
    reviewedAt,
    'Song-family reviewedAt'
  );
  const exactConfirmations = reviewConfirmations(confirmations);
  const currentById = new Map(
    prepared.currentFamily.map(current => [current.song.id, current])
  );
  const capturedById = new Map();
  for (const member of prepared.members) {
    const reviewed = applied.documentsByKey[member.memberKey];
    if (!reviewed || reviewed.song.id !== member.songId) {
      fail(
        'INVALID_CURRENT_SERVICE_SONG_FAMILY_REVIEW',
        'Reviewed family document identity changed unexpectedly.'
      );
    }
    capturedById.set(member.songId, { member, reviewed });
  }
  const finalById = new Map();
  for (const current of prepared.currentFamily) {
    finalById.set(current.song.id, {
      song: current.song,
      documentSource: current.documentSource,
      revision: current.revision,
      capturedMember: null
    });
  }
  for (const [songId, captured] of capturedById) {
    finalById.set(songId, {
      ...captured.reviewed,
      capturedMember: captured.member
    });
  }
  assertProspectiveFamilyCapacity(
    prepared.members,
    prepared.currentFamily,
    { exactDocuments: [...finalById.values()] }
  );
  const rootSongId = prepared.members[0].songId;
  const root = finalById.get(rootSongId);
  if (!root || root.song.translationOf !== null) {
    fail(
      'INVALID_CURRENT_SERVICE_SONG_FAMILY_REVIEW',
      'Reviewed family has no exact original root.'
    );
  }
  for (const member of finalById.values()) {
    if (member.song.id === rootSongId) continue;
    if (
      member.song.translationOf !== rootSongId
      || !compareSongSections(root.song, member.song).compatible
    ) {
      fail(
        'CURRENT_SERVICE_SONG_FAMILY_STRUCTURE_MISMATCH',
        `${member.song.title} no longer aligns with the reviewed root. Capture that translation too or preserve the current root structure.`,
        { songId: member.song.id, rootSongId }
      );
    }
  }

  const members = [...finalById.values()]
    .sort((left, right) =>
      Number(Boolean(left.song.translationOf))
        - Number(Boolean(right.song.translationOf))
      || compareCanonicalText(left.song.id, right.song.id))
    .map(final => {
      const current = currentById.get(final.song.id) || null;
      const action = current === null
        ? 'create'
        : current.revision === final.revision
          ? 'reuse'
          : 'update';
      return {
        songId: final.song.id,
        familyRole: final.song.id === rootSongId
          ? 'original'
          : 'translation',
        translationOf: final.song.translationOf,
        action,
        expectedRevision: current?.revision || null,
        reviewedRevision: final.revision,
        finalTextSha256: songTextHash(final.song),
        documentSource: final.documentSource,
        localServiceRights: final.capturedMember
          ? localServiceRightsEvidence(
            final.localServiceRightsSelection,
            exactReviewedAt
          )
          : null,
        captures: final.capturedMember
          ? [memberCapture(final.capturedMember)]
          : []
      };
    });
  const captureMemberById = new Map(
    prepared.members.map(member => [member.songId, member])
  );
  const occurrences = applied.result.decisionEvidence.map((decision, index) => ({
    occurrenceId: decision.occurrenceId,
    action: decision.action,
    sectionId: decision.sectionId,
    repeatOfOccurrenceId: decision.repeatOfOccurrenceId,
    evidence: prepared.members.map(member => ({
      songId: member.songId,
      captureOrdinal: 1,
      slideNumber: captureMemberById
        .get(member.songId)
        .selection
        .slideNumbers[index]
    }))
  }));
  const decksByRole = new Map();
  for (const member of prepared.members) {
    const deck = {
      roleId: member.source.roleId,
      sourceName: member.source.fileName,
      sourceSizeBytes: member.source.sourceSizeBytes,
      deckSha256: member.source.deckSha256,
      deckSlideCount: member.source.deckSlideCount
    };
    const existing = decksByRole.get(deck.roleId);
    if (
      existing
      && JSON.stringify(existing) !== JSON.stringify(deck)
    ) {
      fail(
        'INVALID_CURRENT_SERVICE_SONG_FAMILY_REVIEW',
        'One service role resolved to two different reviewed source decks.'
      );
    }
    decksByRole.set(deck.roleId, deck);
  }
  return deepFreeze({
    schemaVersion: SONG_FAMILY_REVIEW_SNAPSHOT_SCHEMA_VERSION,
    kind: SONG_FAMILY_REVIEW_SNAPSHOT_KIND,
    reviewScope: SONG_FAMILY_REVIEW_SCOPE,
    confirmations: exactConfirmations,
    reviewedAt: exactReviewedAt,
    serviceSet: {
      id: prepared.serviceSet.id,
      fingerprint: prepared.serviceSet.fingerprint,
      serviceDate: prepared.serviceSet.serviceDate,
      profileId: prepared.serviceSet.profileId,
      extractor: {
        id: CURRENT_SERVICE_SONG_FAMILY_EXTRACTOR_ID,
        version: CURRENT_SERVICE_SONG_FAMILY_EXTRACTOR_VERSION
      },
      decks: [...decksByRole.values()]
    },
    family: {
      rootSongId,
      members,
      occurrences
    }
  });
}

module.exports = {
  CURRENT_SERVICE_SONG_FAMILY_EXTRACTOR_ID,
  CURRENT_SERVICE_SONG_FAMILY_EXTRACTOR_VERSION,
  CURRENT_SERVICE_SONG_FAMILY_MAX_PREVIEW_CHARS,
  CURRENT_SERVICE_SONG_FAMILY_REVIEW_KIND,
  CURRENT_SERVICE_SONG_FAMILY_REVIEW_SCHEMA_VERSION,
  CurrentServiceSongFamilyReviewError,
  applyCurrentServiceSongFamilyReview,
  createCurrentServiceSongFamilyReview,
  currentServiceSongFamilyReviewSnapshot
};
