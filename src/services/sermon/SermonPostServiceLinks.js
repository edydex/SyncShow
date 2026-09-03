'use strict';

const { isIP } = require('node:net');

const { normalizeSermonDocument, upgradeSermonDocument } = require('./SermonDocument');

const POST_SERVICE_ACTIONS = new Set(['save-draft', 'mark-ready']);
const POST_SERVICE_RECORDING_KINDS = new Set(['audio', 'video']);
const POST_SERVICE_TEXT_KINDS = new Set(['document', 'transcript']);
const POST_SERVICE_STATUSES = new Set(['pending', 'ready']);
const POST_SERVICE_SLOT_PREFIX = 'post-service:';
const MAX_POST_SERVICE_URL_BYTES = 2048;
const NONPUBLIC_HOST_SUFFIXES = Object.freeze([
  '.arpa',
  '.example',
  '.home',
  '.internal',
  '.invalid',
  '.lan',
  '.local',
  '.localhost',
  '.onion',
  '.test'
]);

class SermonPostServiceLinksError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SermonPostServiceLinksError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new SermonPostServiceLinksError(code, message, details);
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function strictHttpsUrl(value, field, { required = false } = {}) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string') {
    fail('INVALID_POST_SERVICE_URL', `${field} must be an HTTPS link.`);
  }
  const candidate = value.trim().normalize('NFC');
  if (!candidate) {
    if (required) {
      fail('MISSING_POST_SERVICE_URL', `${field} needs an HTTPS link.`);
    }
    return null;
  }
  if (
    Buffer.byteLength(candidate, 'utf8') > MAX_POST_SERVICE_URL_BYTES
    || /[\u0000-\u001f\u007f\\]/u.test(candidate)
  ) {
    fail(
      'INVALID_POST_SERVICE_URL',
      `${field} must be a normal HTTPS link without control characters or backslashes.`
    );
  }
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch (_error) {
    fail('INVALID_POST_SERVICE_URL', `${field} must be a complete HTTPS link.`);
  }
  if (
    parsed.protocol !== 'https:'
    || !parsed.hostname
    || parsed.username
    || parsed.password
  ) {
    fail(
      'INVALID_POST_SERVICE_URL',
      `${field} must use HTTPS and cannot contain embedded sign-in details.`
    );
  }
  if (parsed.hash) {
    fail(
      'INVALID_POST_SERVICE_URL',
      `${field} cannot contain a fragment after “#”.`
    );
  }
  const canonical = parsed.toString();
  if (Buffer.byteLength(canonical, 'utf8') > MAX_POST_SERVICE_URL_BYTES) {
    fail('INVALID_POST_SERVICE_URL', `${field} is too long.`);
  }
  return canonical;
}

function enumValue(value, field, allowed) {
  if (typeof value !== 'string' || !allowed.has(value)) {
    fail('INVALID_POST_SERVICE_LINK', `${field} is not supported.`);
  }
  return value;
}

function normalizeSlot(raw, category) {
  if (raw === undefined || raw === null) return null;
  if (!isRecord(raw)) {
    fail(
      'INVALID_POST_SERVICE_LINK',
      `${category === 'recording' ? 'Recording' : 'Notes or transcript'} details are invalid.`
    );
  }
  const kind = enumValue(
    raw.kind,
    `${category === 'recording' ? 'Recording' : 'Notes or transcript'} kind`,
    category === 'recording'
      ? POST_SERVICE_RECORDING_KINDS
      : POST_SERVICE_TEXT_KINDS
  );
  const status = enumValue(
    raw.status,
    `${category === 'recording' ? 'Recording' : 'Notes or transcript'} status`,
    POST_SERVICE_STATUSES
  );
  const url = strictHttpsUrl(
    raw.url,
    category === 'recording' ? 'Recording link' : 'Notes or transcript link',
    { required: status === 'ready' }
  );
  if (!url && category === 'recording') return { kind, status, url: null };
  if (!url) return null;
  return { kind, status, url };
}

function managedSlotIds(document) {
  const language = document.defaultLanguage;
  return Object.freeze({
    recording: `${POST_SERVICE_SLOT_PREFIX}recording:${language}`,
    text: `${POST_SERVICE_SLOT_PREFIX}text:${language}`
  });
}

function managedSlotCategory(media, ids) {
  if (media.id === ids.recording) return 'recording';
  if (media.id === ids.text) return 'text';
  return null;
}

function hasCompleteLocalRecording(media) {
  return Boolean(
    media
    && media.sha256
    && media.fileName
    && media.mediaType
    && media.sizeBytes !== null
  );
}

function assertManagedSlotCompatible(media, category, document) {
  const kindAllowed = category === 'recording'
    ? POST_SERVICE_RECORDING_KINDS.has(media.kind)
    : POST_SERVICE_TEXT_KINDS.has(media.kind);
  const hasCompatibleLocation = Boolean(media.url)
    || (category === 'recording' && hasCompleteLocalRecording(media));
  if (
    !kindAllowed
    || media.language !== document.defaultLanguage
    || !hasCompatibleLocation
  ) {
    fail(
      'POST_SERVICE_MEDIA_ID_COLLISION',
      'A reserved post-service link identity is already used by incompatible sermon media.'
    );
  }
}

function slotMedia(document, category, slot, id, existing = null) {
  if (!slot) return null;
  const title = category === 'recording'
    ? slot.kind === 'video' ? 'Sermon video' : 'Sermon audio'
    : slot.kind === 'transcript' ? 'Sermon transcript' : 'Sermon notes';
  const localRecording = category === 'recording' && existing?.sha256
    ? existing
    : null;
  if (category === 'recording' && !slot.url && !hasCompleteLocalRecording(existing)) {
    return null;
  }
  if (localRecording && slot.kind !== localRecording.kind) {
    fail(
      'LOCAL_RECORDING_KIND_MISMATCH',
      'The reviewed recording type must match the locally preserved file.'
    );
  }
  return {
    id,
    kind: localRecording?.kind || slot.kind,
    status: slot.status,
    title,
    language: document.defaultLanguage,
    mediaType: localRecording?.mediaType || '',
    fileName: localRecording?.fileName || null,
    sha256: localRecording?.sha256 || null,
    sizeBytes: localRecording?.sizeBytes ?? null,
    durationSeconds: localRecording?.durationSeconds ?? null,
    url: slot.url
  };
}

function httpsLocation(value) {
  try {
    const parsed = new URL(value || '');
    return parsed.protocol === 'https:'
      && Boolean(parsed.hostname)
      && !parsed.username
      && !parsed.password
      && !parsed.hash;
  } catch (_error) {
    return false;
  }
}

function stablePublicHttpsLocation(value, { requireFilePath = false } = {}) {
  if (
    typeof value !== 'string'
    || Buffer.byteLength(value, 'utf8') > MAX_POST_SERVICE_URL_BYTES
    || /[\u0000-\u001f\u007f\\]/u.test(value)
  ) {
    return false;
  }
  try {
    const parsed = new URL(value);
    const canonical = parsed.toString();
    const hostname = parsed.hostname
      .replace(/^\[/, '')
      .replace(/\]$/, '')
      .toLowerCase();
    return parsed.protocol === 'https:'
      && Boolean(hostname)
      && !parsed.username
      && !parsed.password
      && !parsed.hash
      && !parsed.search
      && !parsed.port
      && !hostname.endsWith('.')
      && hostname.includes('.')
      && isIP(hostname) === 0
      && hostname !== 'localhost'
      && !NONPUBLIC_HOST_SUFFIXES.some(suffix => hostname.endsWith(suffix))
      && (!requireFilePath
        || (parsed.pathname !== '/' && !parsed.pathname.endsWith('/')))
      && canonical.length <= MAX_POST_SERVICE_URL_BYTES
      && Buffer.byteLength(canonical, 'utf8') <= MAX_POST_SERVICE_URL_BYTES;
  } catch (_error) {
    return false;
  }
}

function analyzeSermonPostServiceReadiness(rawDocument) {
  const document = normalizeSermonDocument(rawDocument);
  const confirmedPrimary = document.references.some(reference =>
    reference.role === 'primary' && reference.reviewStatus === 'confirmed');
  const reviewedBodyReady = document.schemaVersion === 3
    && document.body.length > 0;
  const pageReady = httpsLocation(document.publication.canonicalUrl);
  const readyMedia = document.media.filter(media =>
    media.status === 'ready' && stablePublicHttpsLocation(media.url));
  const recordingReady = readyMedia.some(media =>
    POST_SERVICE_RECORDING_KINDS.has(media.kind)
      && stablePublicHttpsLocation(media.url, { requireFilePath: true }));
  const textReady = readyMedia.some(media =>
    POST_SERVICE_TEXT_KINDS.has(media.kind));
  const pageOrTextReady = pageReady || textReady;
  const revisitContentReady = reviewedBodyReady || pageOrTextReady;
  const requirements = Object.freeze({
    confirmedPrimary,
    recordingReady,
    reviewedBodyReady,
    pageOrTextReady,
    revisitContentReady
  });
  const missing = Object.freeze([
    ...(!confirmedPrimary ? ['confirmed-primary'] : []),
    ...(!recordingReady ? ['available-recording'] : []),
    ...(!revisitContentReady
      ? ['reviewed-body-sermon-page-or-available-text']
      : [])
  ]);
  return Object.freeze({
    ready: missing.length === 0,
    publicationStatus: document.publication.status,
    visibility: document.publication.visibility,
    reviewedBodyReady,
    pageReady,
    recordingReady,
    textReady,
    revisitContentReady,
    requirements,
    missing
  });
}

function assertPostServiceDocumentEditable(document) {
  if (!['published', 'archived'].includes(document.publication.status)) return;
  fail(
    'POST_SERVICE_PUBLICATION_LOCKED',
    document.publication.status === 'published'
      ? 'Published sermon links must be revised from Community with publication audit context.'
      : 'Archived sermon links cannot be changed until the sermon is explicitly restored.'
  );
}

function normalizeLocalRecording(rawMedia, document, id) {
  if (!isRecord(rawMedia)) {
    fail(
      'INVALID_LOCAL_SERMON_RECORDING',
      'Locally preserved sermon recording metadata is invalid.'
    );
  }
  const allowedKeys = new Set([
    'kind',
    'mediaType',
    'fileName',
    'sha256',
    'sizeBytes',
    'durationSeconds'
  ]);
  for (const key of Object.keys(rawMedia)) {
    if (!allowedKeys.has(key)) {
      fail(
        'INVALID_LOCAL_SERMON_RECORDING',
        'Local sermon recording metadata cannot set managed identity, review, URL, or path fields.',
        { field: key }
      );
    }
  }
  const kind = enumValue(rawMedia.kind, 'Local sermon recording kind', POST_SERVICE_RECORDING_KINDS);
  if (typeof rawMedia.mediaType !== 'string' || !rawMedia.mediaType.trim()) {
    fail(
      'INVALID_LOCAL_SERMON_RECORDING',
      'Local sermon recording mediaType is required.'
    );
  }
  if (!Number.isSafeInteger(rawMedia.sizeBytes) || rawMedia.sizeBytes < 0) {
    fail(
      'INVALID_LOCAL_SERMON_RECORDING',
      'Local sermon recording sizeBytes must be a non-negative integer.'
    );
  }

  const normalized = normalizeSermonDocument({
    ...document,
    media: [{
      id,
      kind,
      status: 'pending',
      title: kind === 'video' ? 'Sermon video' : 'Sermon audio',
      language: document.defaultLanguage,
      mediaType: rawMedia.mediaType,
      fileName: rawMedia.fileName,
      sha256: rawMedia.sha256,
      sizeBytes: rawMedia.sizeBytes,
      durationSeconds: rawMedia.durationSeconds ?? null,
      url: null
    }]
  }).media[0];
  if (!hasCompleteLocalRecording(normalized)) {
    fail(
      'INVALID_LOCAL_SERMON_RECORDING',
      'Local sermon recording metadata needs a file name, media type, content hash, and size.'
    );
  }
  return normalized;
}

function attachLocalSermonRecording(rawDocument, rawMedia) {
  const current = upgradeSermonDocument(rawDocument);
  assertPostServiceDocumentEditable(current);

  const ids = managedSlotIds(current);
  const localRecording = normalizeLocalRecording(rawMedia, current, ids.recording);
  const preservedMedia = [];
  let existingRecording = null;
  let existingText = null;
  for (const media of current.media) {
    const category = managedSlotCategory(media, ids);
    if (!category) {
      preservedMedia.push(media);
      continue;
    }
    assertManagedSlotCompatible(media, category, current);
    if (category === 'recording') {
      existingRecording = media;
    } else {
      existingText = media;
    }
  }

  const sameBytes = existingRecording?.sha256 === localRecording.sha256;
  const preserveReviewedLink = sameBytes
    && httpsLocation(existingRecording?.url)
    && POST_SERVICE_STATUSES.has(existingRecording.status);
  const recording = {
    ...localRecording,
    status: preserveReviewedLink ? existingRecording.status : 'pending',
    url: preserveReviewedLink ? existingRecording.url : null
  };
  const recordingRemainsReady = preserveReviewedLink
    && existingRecording.status === 'ready';
  const nextDocument = normalizeSermonDocument({
    ...current,
    media: [
      ...preservedMedia,
      recording,
      ...(existingText ? [existingText] : [])
    ],
    publication: {
      ...current.publication,
      status: current.publication.status === 'ready'
        && (!sameBytes || !recordingRemainsReady)
        ? 'draft'
        : current.publication.status,
      publishedAt: null
    }
  });
  const readiness = analyzeSermonPostServiceReadiness(nextDocument);
  return deepFreeze({
    document: nextDocument,
    readiness
  });
}

function planSermonPostServiceLinks(rawDocument, rawReview = {}) {
  const current = upgradeSermonDocument(rawDocument);
  if (!isRecord(rawReview)) {
    fail('INVALID_POST_SERVICE_REVIEW', 'Post-service link review is invalid.');
  }
  const action = enumValue(
    rawReview.action,
    'Post-service review action',
    POST_SERVICE_ACTIONS
  );
  assertPostServiceDocumentEditable(current);

  const canonicalUrl = strictHttpsUrl(
    rawReview.canonicalUrl,
    'Canonical sermon page'
  );
  const recording = normalizeSlot(rawReview.recording, 'recording');
  const textLink = normalizeSlot(rawReview.text, 'text');
  if (recording?.url && textLink?.url && recording.url === textLink.url) {
    fail(
      'DUPLICATE_POST_SERVICE_URL',
      'Use distinct links for the recording and notes, or put the shared page in Canonical sermon page.'
    );
  }

  const ids = managedSlotIds(current);
  const preservedMedia = [];
  let existingRecording = null;
  let existingText = null;
  for (const media of current.media) {
    const category = managedSlotCategory(media, ids);
    if (!category) {
      preservedMedia.push(media);
      continue;
    }
    assertManagedSlotCompatible(media, category, current);
    if (category === 'recording') {
      existingRecording = media;
    } else {
      existingText = media;
    }
  }
  const recordingMedia = slotMedia(
    current,
    'recording',
    recording,
    ids.recording,
    existingRecording
  );
  const textMedia = slotMedia(current, 'text', textLink, ids.text, existingText);
  const nextDocument = normalizeSermonDocument({
    ...current,
    media: [
      ...preservedMedia,
      ...(recordingMedia ? [recordingMedia] : []),
      ...(textMedia ? [textMedia] : [])
    ],
    publication: {
      ...current.publication,
      status: action === 'mark-ready' ? 'ready' : 'draft',
      publishedAt: null,
      canonicalUrl
    }
  });
  const readiness = analyzeSermonPostServiceReadiness(nextDocument);
  if (action === 'mark-ready' && !readiness.ready) {
    fail(
      'POST_SERVICE_NOT_READY',
      'Before marking this sermon ready, confirm its primary passage, an available recording, and either reviewed sermon text, its sermon page, or available notes/transcript.',
      { missing: readiness.missing }
    );
  }
  return Object.freeze({
    document: nextDocument,
    readiness,
    action
  });
}

module.exports = {
  MAX_POST_SERVICE_URL_BYTES,
  POST_SERVICE_SLOT_PREFIX,
  SermonPostServiceLinksError,
  analyzeSermonPostServiceReadiness,
  attachLocalSermonRecording,
  planSermonPostServiceLinks,
  stablePublicHttpsLocation,
  strictHttpsUrl
};
