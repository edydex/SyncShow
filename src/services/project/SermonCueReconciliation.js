'use strict';

const crypto = require('crypto');
const path = require('path');

const {
  isPowerPointCompanionProject,
  normalizeServiceProject,
  resolveSermonSourceLink,
  serializeServiceProject
} = require('./ServiceProject');
const {
  normalizeSermonSourceExtractionProposal
} = require('../sermon/SermonSourceExtractionProposal');

const SERMON_CUE_RECONCILIATION_SCHEMA_VERSION = 3;
const SERMON_CUE_RECONCILIATION_KIND =
  'syncshow-sermon-cue-reconciliation-proposal';
const SERMON_CUE_RECONCILIATION_RECEIPT_SCHEMA_VERSION = 3;
const SERMON_CUE_RECONCILIATION_RECEIPT_KIND =
  'syncshow-sermon-cue-reconciliation-receipt';
const EXTRACTION_SNAPSHOT_SCHEMA_VERSION = 1;
const EXTRACTION_SNAPSHOT_KIND = 'syncshow-sermon-extraction-snapshot';
const PPTX_MEDIA_TYPE =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation';

const MAX_RECONCILIATION_CHANNELS = 32;
const MAX_RECONCILIATION_ROWS = 256;
const MAX_RECONCILIATION_EXISTING_CHILDREN = 256;
const MAX_PROJECT_TEXT_CHARS = 20_000;
const MAX_RECONCILIATION_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_SPANS = 256;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const LANGUAGE_PATTERN = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/;
const SERMON_RECONCILIATION_GROUP_KINDS = Object.freeze([
  'sermon',
  'section',
  'point',
  'subpoint'
]);
const TRUSTED_SOURCE_SPAN_FOREGROUND = '#ffc000';
const TRUSTED_SOURCE_SPAN_WEIGHTS = Object.freeze(['400', '700']);

class SermonCueReconciliationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SermonCueReconciliationError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function fail(code, message, details = {}) {
  throw new SermonCueReconciliationError(code, message, details);
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(raw, requiredKeys, optionalKeys, field, code) {
  if (!isRecord(raw)) {
    fail(code, `${field} must be an object.`, { field });
  }
  const required = new Set(requiredKeys);
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  const actual = Object.keys(raw);
  const missing = requiredKeys.filter(key =>
    !Object.prototype.hasOwnProperty.call(raw, key));
  const unexpected = actual.filter(key => !allowed.has(key));
  if (missing.length > 0 || unexpected.length > 0) {
    fail(code, `${field} has unsupported or missing fields.`, {
      field,
      missing,
      unexpected
    });
  }
}

function identifier(value, field, code = 'INVALID_RECONCILIATION_REQUEST') {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    fail(code, `${field} must be a canonical identifier.`, { field });
  }
  return value;
}

function nullableIdentifier(
  value,
  field,
  code = 'INVALID_RECONCILIATION_REQUEST'
) {
  return value === null ? null : identifier(value, field, code);
}

function revision(value, field, code = 'INVALID_RECONCILIATION_REQUEST') {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    fail(code, `${field} must be a lowercase SHA-256 revision.`, { field });
  }
  return value;
}

function boundedText(
  value,
  field,
  maximum,
  { allowEmpty = false, code = 'INVALID_RECONCILIATION_REQUEST' } = {}
) {
  if (
    typeof value !== 'string'
    || (!allowEmpty && value.length === 0)
    || value.length > maximum
  ) {
    fail(code, `${field} is outside its safe text limit.`, {
      field,
      maximum
    });
  }
  return value;
}

function splitsSurrogatePair(value, offset) {
  if (offset <= 0 || offset >= value.length) return false;
  const previous = value.charCodeAt(offset - 1);
  const current = value.charCodeAt(offset);
  return previous >= 0xD800
    && previous <= 0xDBFF
    && current >= 0xDC00
    && current <= 0xDFFF;
}

function normalizeTrustedTextSpans(
  raw,
  authoritativeText,
  field,
  code = 'INVALID_PROPOSAL'
) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_TEXT_SPANS) {
    fail(
      code,
      `${field} must contain at most ${MAX_TEXT_SPANS} inline formatting ranges.`,
      { field, maximum: MAX_TEXT_SPANS }
    );
  }
  const spans = [];
  let previousEnd = 0;
  for (const [index, candidate] of raw.entries()) {
    const spanField = `${field} ${index + 1}`;
    exactKeys(
      candidate,
      ['start', 'end', 'foreground'],
      ['weight'],
      spanField,
      code
    );
    if (
      !Number.isSafeInteger(candidate.start)
      || !Number.isSafeInteger(candidate.end)
      || candidate.start < 0
      || candidate.end <= candidate.start
      || candidate.end > authoritativeText.length
    ) {
      fail(
        code,
        `${spanField} must be a non-empty range inside its authoritative text.`,
        {
          field: spanField,
          start: candidate.start,
          end: candidate.end,
          textLength: authoritativeText.length
        }
      );
    }
    if (candidate.start < previousEnd) {
      fail(
        code,
        `${field} ranges must be sorted and must not overlap.`,
        {
          field,
          index,
          previousEnd,
          start: candidate.start
        }
      );
    }
    if (
      splitsSurrogatePair(authoritativeText, candidate.start)
      || splitsSurrogatePair(authoritativeText, candidate.end)
    ) {
      fail(
        code,
        `${spanField} cannot split a Unicode character.`,
        {
          field: spanField,
          start: candidate.start,
          end: candidate.end
        }
      );
    }
    const span = {
      start: candidate.start,
      end: candidate.end,
      foreground: TRUSTED_SOURCE_SPAN_FOREGROUND
    };
    if (candidate.foreground !== TRUSTED_SOURCE_SPAN_FOREGROUND) {
      fail(
        code,
        `${spanField} foreground must be the trusted direct PowerPoint emphasis color.`,
        {
          field: `${spanField} foreground`,
          allowed: TRUSTED_SOURCE_SPAN_FOREGROUND
        }
      );
    }
    if (candidate.weight !== undefined) {
      if (
        typeof candidate.weight !== 'string'
        || !TRUSTED_SOURCE_SPAN_WEIGHTS.includes(candidate.weight)
      ) {
        fail(
          code,
          `${spanField} weight is unsupported.`,
          {
            field: `${spanField} weight`,
            allowed: TRUSTED_SOURCE_SPAN_WEIGHTS
          }
        );
      }
      span.weight = candidate.weight;
    }
    spans.push(span);
    previousEnd = candidate.end;
  }
  return spans;
}

function positiveInteger(
  value,
  field,
  maximum,
  code = 'INVALID_RECONCILIATION_REQUEST'
) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    fail(code, `${field} is outside its safe numeric limit.`, {
      field,
      maximum
    });
  }
  return value;
}

function nonNegativeInteger(
  value,
  field,
  maximum,
  code = 'INVALID_RECONCILIATION_REQUEST'
) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    fail(code, `${field} is outside its safe numeric limit.`, {
      field,
      maximum
    });
  }
  return value;
}

function canonicalTimestamp(
  value,
  field,
  code = 'INVALID_RECONCILIATION_REQUEST'
) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    fail(code, `${field} must be a canonical timestamp.`, { field });
  }
  const normalized = new Date(value).toISOString();
  if (normalized !== value) {
    fail(code, `${field} must be a canonical timestamp.`, { field });
  }
  return normalized;
}

function proposalTimestamp(value) {
  const date = value instanceof Date
    ? value
    : new Date(value === undefined ? Date.now() : value);
  if (Number.isNaN(date.getTime())) {
    fail(
      'INVALID_RECONCILIATION_REQUEST',
      'Reconciliation proposal time is invalid.'
    );
  }
  return date.toISOString();
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
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

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonicalHash(value) {
  return sha256(`${canonicalJson(value)}\n`);
}

function serviceProjectRevisionId(project) {
  return sha256(serializeServiceProject(project));
}

function canonicalProject(raw) {
  try {
    return normalizeServiceProject(raw);
  } catch (error) {
    fail(
      'INVALID_PROJECT',
      'The service project is not valid for sermon cue reconciliation.',
      { causeCode: error?.code || null }
    );
  }
}

function normalizeBinding(raw, code = 'INVALID_SNAPSHOT') {
  exactKeys(raw, [
    'sermonId',
    'baseSermonRevisionId',
    'sourceId',
    'sourceSha256',
    'sourceKind',
    'extractorId',
    'extractorVersion'
  ], [], 'Extraction snapshot binding', code);
  return {
    sermonId: identifier(raw.sermonId, 'Snapshot sermon id', code),
    baseSermonRevisionId: revision(
      raw.baseSermonRevisionId,
      'Snapshot base sermon revision',
      code
    ),
    sourceId: identifier(raw.sourceId, 'Snapshot source id', code),
    sourceSha256: revision(raw.sourceSha256, 'Snapshot source revision', code),
    sourceKind: identifier(raw.sourceKind, 'Snapshot source kind', code),
    extractorId: identifier(raw.extractorId, 'Snapshot extractor id', code),
    extractorVersion: positiveInteger(
      raw.extractorVersion,
      'Snapshot extractor version',
      1_000_000,
      code
    )
  };
}

function normalizePublicSnapshot(raw) {
  exactKeys(
    raw,
    ['snapshotHash', 'binding', 'extraction'],
    [],
    'Extraction snapshot',
    'INVALID_SNAPSHOT'
  );
  const snapshotHash = revision(
    raw.snapshotHash,
    'Extraction snapshot hash',
    'INVALID_SNAPSHOT'
  );
  const binding = normalizeBinding(raw.binding);
  let extraction;
  try {
    extraction = normalizeSermonSourceExtractionProposal(raw.extraction);
  } catch (error) {
    fail(
      'INVALID_SNAPSHOT',
      'The extraction snapshot contains an invalid extraction.',
      { causeCode: error?.code || null }
    );
  }
  const expectedBinding = {
    sermonId: binding.sermonId,
    baseSermonRevisionId: binding.baseSermonRevisionId,
    sourceId: extraction.source.id,
    sourceSha256: extraction.source.sha256,
    sourceKind: extraction.source.kind,
    extractorId: extraction.extractor.id,
    extractorVersion: extraction.extractor.version
  };
  if (canonicalJson(binding) !== canonicalJson(expectedBinding)) {
    fail(
      'SNAPSHOT_BINDING_MISMATCH',
      'The extraction snapshot binding does not match its extraction.'
    );
  }
  const record = {
    schemaVersion: EXTRACTION_SNAPSHOT_SCHEMA_VERSION,
    kind: EXTRACTION_SNAPSHOT_KIND,
    binding,
    extraction
  };
  if (canonicalHash(record) !== snapshotHash) {
    fail(
      'SNAPSHOT_HASH_MISMATCH',
      'The extraction snapshot no longer matches its content hash.'
    );
  }
  return { snapshotHash, binding, extraction };
}

function normalizedSourceLanguages(source) {
  return Array.isArray(source.languages)
    ? [...source.languages]
    : [source.language || 'und'];
}

function sameStringList(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function requireSermonCueReconciliationAnchor(
  project,
  anchorItemId,
  sermonId,
  sermonRevisionId
) {
  if (isPowerPointCompanionProject(project)) {
    fail(
      'POWERPOINT_COMPANION_UNSUPPORTED',
      'PowerPoint companions keep their original presentations and cannot create native sermon cues.'
    );
  }
  const anchor = project.items[anchorItemId];
  if (
    !anchor
    || anchor.kind !== 'group'
    || !SERMON_RECONCILIATION_GROUP_KINDS.includes(anchor.groupKind)
  ) {
    fail(
      'INVALID_SERMON_ANCHOR',
      'Choose a semantic sermon outline group before reconciling sermon cues.',
      { anchorItemId }
    );
  }
  let linked;
  try {
    linked = resolveSermonSourceLink(project, anchor);
  } catch (error) {
    fail(
      'SERMON_BINDING_MISMATCH',
      'The selected sermon outline group no longer resolves to an exact sermon revision.',
      { causeCode: error?.code || null }
    );
  }
  const resourceOwner = linked
    ? project.items[linked.resourceOwnerId]
    : null;
  if (
    !linked
    || !resourceOwner
    || resourceOwner.kind !== 'group'
    || resourceOwner.groupKind !== 'sermon'
    || resourceOwner.sermonResourceId !== linked.resourceId
    || linked.resource.document.id !== sermonId
    || linked.resource.sha256 !== sermonRevisionId
  ) {
    fail(
      'SERMON_BINDING_MISMATCH',
      'The selected group does not inherit the expected exact revision from a semantic sermon owner.',
      { anchorItemId }
    );
  }
  if (resourceOwner.sermonSectionId) {
    fail(
      'SECTION_PINNED_SERMON_ANCHOR',
      'The sermon resource owner must represent the whole sermon before its outline groups can be reconciled.',
      {
        anchorItemId,
        resourceOwnerId: resourceOwner.id,
        sectionId: resourceOwner.sermonSectionId
      }
    );
  }
  return { anchor, linked, resourceOwner };
}

function sermonCueAnchorBinding(anchor, linked) {
  return {
    itemId: anchor.id,
    groupKind: anchor.groupKind,
    resourceId: linked.resourceId,
    resourceOwnerId: linked.resourceOwnerId,
    directSectionId: anchor.sermonSectionId || null,
    effectiveSectionId: linked.sectionId || null,
    sectionOwnerId: linked.sectionOwnerId || null,
    childIds: [...anchor.childIds]
  };
}

function existingTargetForChild(project, anchor, linked, itemId, position) {
  const item = project.items[itemId];
  if (!item || item.kind !== 'sermon') return null;
  let resolved;
  try {
    resolved = resolveSermonSourceLink(project, item);
  } catch (_error) {
    return null;
  }
  if (
    !resolved
    || resolved.resourceOwnerId !== linked.resourceOwnerId
    || resolved.resourceId !== linked.resourceId
    || resolved.resource.sha256 !== linked.resource.sha256
  ) {
    return null;
  }
  return {
    itemId: item.id,
    position,
    title: item.title,
    presetId: item.presetId,
    sectionId: item.sermonSectionId || null,
    effectiveSectionId: resolved.sectionId || null,
    sectionOwnerId: resolved.sectionOwnerId || null,
    textByChannel: deepClone(item.textByChannel),
    fingerprint: canonicalHash({
      item,
      resolvedLink: {
        resourceId: resolved.resourceId,
        resourceOwnerId: resolved.resourceOwnerId,
        sermonRevisionId: resolved.resource.sha256,
        sectionId: resolved.sectionId || null,
        sectionOwnerId: resolved.sectionOwnerId || null
      }
    })
  };
}

function existingTargetsForAnchor(project, anchor, linked, {
  code = 'INVALID_RECONCILIATION_REQUEST'
} = {}) {
  if (anchor.childIds.length > MAX_RECONCILIATION_EXISTING_CHILDREN) {
    fail(
      'SERMON_TREE_TOO_LARGE',
      `A selected group may contain at most ${MAX_RECONCILIATION_EXISTING_CHILDREN} direct children for one reviewed reconciliation.`,
      {
        maximum: MAX_RECONCILIATION_EXISTING_CHILDREN,
        childCount: anchor.childIds.length
      }
    );
  }
  const targets = [];
  let totalTextBytes = 0;
  for (const [position, itemId] of anchor.childIds.entries()) {
    const target = existingTargetForChild(
      project,
      anchor,
      linked,
      itemId,
      position
    );
    if (!target) continue;
    for (const value of Object.values(target.textByChannel)) {
      totalTextBytes += Buffer.byteLength(value, 'utf8');
      if (totalTextBytes > MAX_RECONCILIATION_TEXT_BYTES) {
        fail(
          code,
          'Existing sermon cue text exceeds the safe reconciliation review limit.',
          { maximumBytes: MAX_RECONCILIATION_TEXT_BYTES }
        );
      }
    }
    targets.push(target);
  }
  return targets;
}

function requireCompleteRomanWindow(extraction) {
  if (
    extraction.source.kind !== 'slide-notes'
    || extraction.source.mediaType !== PPTX_MEDIA_TYPE
  ) {
    fail(
      'UNSUPPORTED_SOURCE',
      'Sermon cue reconciliation requires an exact PowerPoint slide-notes source.'
    );
  }
  if (
    extraction.truncated.units
    || extraction.truncated.text
    || extraction.truncated.outlineSuggestions
    || extraction.units.some(unit => unit.truncated)
  ) {
    fail(
      'INCOMPLETE_EXTRACTION',
      'A truncated slide extraction cannot seed source-faithful sermon cues.'
    );
  }
  const scope = extraction.suggestionScope;
  if (
    scope.strategy !== 'pptx-roman-outline-window'
    || scope.startOrdinal === null
    || scope.endOrdinal === null
  ) {
    fail(
      'SERMON_WINDOW_REQUIRED',
      'The PowerPoint extraction needs a reviewed Roman-outline sermon window.'
    );
  }
  const windowUnits = extraction.units.slice(
    scope.startOrdinal - 1,
    scope.endOrdinal
  );
  if (
    windowUnits.length < 3
    || windowUnits.some(unit => unit.kind !== 'slide')
  ) {
    fail(
      'SERMON_WINDOW_REQUIRED',
      'The Roman-outline sermon window is incomplete.'
    );
  }
  const romanMarkers = new Set(
    extraction.outlineSuggestions
      .filter(suggestion => suggestion.level === 1)
      .map(suggestion => suggestion.marker)
  );
  if (!['I', 'II', 'III'].every(marker => romanMarkers.has(marker))) {
    fail(
      'SERMON_WINDOW_REQUIRED',
      'The extraction does not contain a complete I/II/III sermon outline window.'
    );
  }
  return windowUnits;
}

function sourceSummary(source) {
  return {
    id: source.id,
    kind: source.kind,
    fileName: source.fileName,
    mediaType: source.mediaType,
    sha256: source.sha256,
    languages: normalizedSourceLanguages(source)
  };
}

function proposalHashPayload(proposal) {
  const {
    id: _id,
    ...payload
  } = proposal;
  return payload;
}

function rowSlot(unitIndex, unitCount, slotCount) {
  if (slotCount === 1 || unitCount === 1) {
    return Math.floor((slotCount - 1) / 2);
  }
  return Math.round((unitIndex * (slotCount - 1)) / (unitCount - 1));
}

function buildRows(channelIds, sourceOptionsByChannel) {
  const slotCount = Math.max(...channelIds.map(channelId =>
    sourceOptionsByChannel[channelId].units.length));
  const slotsByChannel = {};
  for (const channelId of channelIds) {
    const units = sourceOptionsByChannel[channelId].units;
    const slots = new Map();
    units.forEach((unit, index) => {
      const slot = rowSlot(index, units.length, slotCount);
      if (slots.has(slot)) {
        fail(
          'INVALID_SOURCE_MAPPING',
          'Relative sermon-window alignment produced an ambiguous source row.',
          { channelId, slot: slot + 1 }
        );
      }
      slots.set(slot, unit);
    });
    slotsByChannel[channelId] = slots;
  }

  return Array.from({ length: slotCount }, (_, slot) => {
    const suggestionsByChannel = {};
    const unmatchedChannelIds = [];
    for (const channelId of channelIds) {
      const unit = slotsByChannel[channelId].get(slot) || null;
      if (!unit) {
        suggestionsByChannel[channelId] = null;
        unmatchedChannelIds.push(channelId);
      } else {
        suggestionsByChannel[channelId] = {
          unitId: unit.unitId,
          label: unit.label,
          text: unit.text,
          suggested: true
        };
      }
    }
    return {
      id: `row-${String(slot + 1).padStart(3, '0')}`,
      ordinal: slot + 1,
      relativePosition: {
        slot: slot + 1,
        slotCount
      },
      suggested: true,
      suggestionsByChannel,
      unmatchedChannelIds
    };
  });
}

function buildSermonCueReconciliationProposal(options = {}) {
  exactKeys(options, [
    'project',
    'projectRevisionId',
    'anchorItemId',
    'sermonId',
    'sermonRevisionId',
    'sourceMappings'
  ], ['now'], 'Sermon cue reconciliation request', 'INVALID_RECONCILIATION_REQUEST');

  const project = canonicalProject(options.project);
  const projectRevisionId = revision(
    options.projectRevisionId,
    'Saved project revision',
    'INVALID_RECONCILIATION_REQUEST'
  );
  if (serviceProjectRevisionId(project) !== projectRevisionId) {
    fail(
      'PROJECT_REVISION_MISMATCH',
      'The service project does not match the exact saved revision selected for reconciliation.'
    );
  }
  const anchorItemId = identifier(
    options.anchorItemId,
    'Sermon group anchor',
    'INVALID_RECONCILIATION_REQUEST'
  );
  const sermonId = identifier(
    options.sermonId,
    'Sermon id',
    'INVALID_RECONCILIATION_REQUEST'
  );
  const sermonRevisionId = revision(
    options.sermonRevisionId,
    'Sermon revision',
    'INVALID_RECONCILIATION_REQUEST'
  );
  const { anchor, linked } = requireSermonCueReconciliationAnchor(
    project,
    anchorItemId,
    sermonId,
    sermonRevisionId
  );
  const existingTargets = existingTargetsForAnchor(
    project,
    anchor,
    linked
  );

  if (
    !Array.isArray(options.sourceMappings)
    || options.sourceMappings.length < 1
    || options.sourceMappings.length > MAX_RECONCILIATION_CHANNELS
  ) {
    fail(
      'INVALID_SOURCE_MAPPING',
      `Choose between one and ${MAX_RECONCILIATION_CHANNELS} explicit source-to-output mappings.`
    );
  }

  const mappedChannels = new Set();
  const sourceOptionsByChannel = {};
  let totalTextBytes = 0;
  for (const [index, rawMapping] of options.sourceMappings.entries()) {
    exactKeys(
      rawMapping,
      ['channelId', 'snapshot'],
      [],
      `Source mapping ${index + 1}`,
      'INVALID_SOURCE_MAPPING'
    );
    const channelId = identifier(
      rawMapping.channelId,
      `Source mapping ${index + 1} channel`,
      'INVALID_SOURCE_MAPPING'
    );
    if (!project.channelIds.includes(channelId)) {
      fail(
        'UNKNOWN_CHANNEL',
        'A selected sermon source was mapped to an unavailable output channel.',
        { channelId }
      );
    }
    if (mappedChannels.has(channelId)) {
      fail(
        'DUPLICATE_CHANNEL_MAPPING',
        'Each output channel can receive only one explicitly selected source.',
        { channelId }
      );
    }
    mappedChannels.add(channelId);

    const snapshot = normalizePublicSnapshot(rawMapping.snapshot);
    const { binding, extraction } = snapshot;
    const source = linked.resource.document.sources.find(candidate =>
      candidate.id === binding.sourceId);
    if (!source) {
      fail(
        'UNKNOWN_SERMON_SOURCE',
        'A mapped extraction source is not part of the pinned sermon revision.',
        { channelId, sourceId: binding.sourceId }
      );
    }
    if (
      binding.sermonId !== sermonId
      || binding.baseSermonRevisionId !== sermonRevisionId
      || binding.sourceSha256 !== source.sha256
      || binding.sourceKind !== source.kind
      || extraction.source.id !== source.id
      || extraction.source.sha256 !== source.sha256
      || extraction.source.kind !== source.kind
      || extraction.source.mediaType !== source.mediaType
      || !sameStringList(
        extraction.source.languages,
        normalizedSourceLanguages(source)
      )
    ) {
      fail(
        'SNAPSHOT_BINDING_MISMATCH',
        'A mapped extraction snapshot is not exact-bound to the pinned sermon source.',
        { channelId, sourceId: source.id }
      );
    }
    if (
      source.kind !== 'slide-notes'
      || source.mediaType !== PPTX_MEDIA_TYPE
    ) {
      fail(
        'UNSUPPORTED_SOURCE',
        'Only preserved PowerPoint slide-note sources can seed sermon cue reconciliation.',
        { channelId, sourceId: source.id }
      );
    }

    const windowUnits = requireCompleteRomanWindow(extraction);
    const units = windowUnits.map(unit => {
      if (unit.text.length > MAX_PROJECT_TEXT_CHARS) {
        fail(
          'SOURCE_UNIT_TOO_LARGE',
          'One source slide is too large to preserve as a native sermon cue.',
          { channelId, unitId: unit.id, maximum: MAX_PROJECT_TEXT_CHARS }
        );
      }
      totalTextBytes += Buffer.byteLength(unit.text, 'utf8');
      if (totalTextBytes > MAX_RECONCILIATION_TEXT_BYTES) {
        fail(
          'PROPOSAL_TOO_LARGE',
          'The selected sermon windows exceed the safe reconciliation text limit.',
          { maximumBytes: MAX_RECONCILIATION_TEXT_BYTES }
        );
      }
      const spans = normalizeTrustedTextSpans(
        unit.spans,
        unit.text,
        `Snapshot unit ${unit.id} spans`,
        'INVALID_SNAPSHOT'
      );
      return {
        unitId: unit.id,
        ordinal: unit.ordinal,
        label: unit.label,
        text: unit.text,
        ...(spans.length > 0 ? { spans } : {})
      };
    });
    sourceOptionsByChannel[channelId] = {
      channelId,
      channelLabel: project.channels[channelId].label,
      channelLanguage: project.channels[channelId].language,
      source: sourceSummary(source),
      snapshotHash: snapshot.snapshotHash,
      extractor: {
        id: extraction.extractor.id,
        version: extraction.extractor.version
      },
      window: {
        startUnitId: extraction.suggestionScope.startUnitId,
        endUnitId: extraction.suggestionScope.endUnitId,
        startOrdinal: extraction.suggestionScope.startOrdinal,
        endOrdinal: extraction.suggestionScope.endOrdinal,
        unitCount: units.length
      },
      units
    };
  }

  const channelIds = project.channelIds.filter(channelId =>
    mappedChannels.has(channelId));
  const proposalWithoutId = {
    schemaVersion: SERMON_CUE_RECONCILIATION_SCHEMA_VERSION,
    kind: SERMON_CUE_RECONCILIATION_KIND,
    createdAt: proposalTimestamp(options.now),
    project: {
      id: project.id,
      revisionId: projectRevisionId,
      revision: project.revision,
      updatedAt: project.updatedAt,
      planningStatus: project.planning?.status || null
    },
    anchor: sermonCueAnchorBinding(anchor, linked),
    sermon: {
      id: sermonId,
      revisionId: sermonRevisionId
    },
    channelIds,
    unmappedChannelIds: project.channelIds.filter(channelId =>
      !mappedChannels.has(channelId)),
    existingTargets,
    sourceOptionsByChannel,
    rows: buildRows(channelIds, sourceOptionsByChannel)
  };
  return deepFreeze({
    ...proposalWithoutId,
    id: canonicalHash(proposalWithoutId)
  });
}

function normalizedIdentifierList(raw, field, maximum, code) {
  if (!Array.isArray(raw) || raw.length > maximum) {
    fail(code, `${field} is outside its safe list limit.`, {
      field,
      maximum
    });
  }
  const result = raw.map((value, index) =>
    identifier(value, `${field} ${index + 1}`, code));
  if (new Set(result).size !== result.length) {
    fail(code, `${field} contains a duplicate identifier.`, { field });
  }
  return result;
}

function normalizeExistingTargets(
  raw,
  anchor,
  projectChannelIds
) {
  const anchorChildIds = anchor.childIds;
  if (
    !Array.isArray(raw)
    || raw.length > MAX_RECONCILIATION_EXISTING_CHILDREN
  ) {
    fail(
      'INVALID_PROPOSAL',
      'Proposal existing sermon targets exceed the safe review limit.'
    );
  }
  const seen = new Set();
  const targets = [];
  let previousPosition = -1;
  let totalTextBytes = 0;
  for (const [index, candidate] of raw.entries()) {
    const field = `Proposal existing sermon target ${index + 1}`;
    exactKeys(candidate, [
      'itemId',
      'position',
      'title',
      'presetId',
      'sectionId',
      'effectiveSectionId',
      'sectionOwnerId',
      'textByChannel',
      'fingerprint'
    ], [], field, 'INVALID_PROPOSAL');
    const itemId = identifier(
      candidate.itemId,
      `${field} item id`,
      'INVALID_PROPOSAL'
    );
    const position = nonNegativeInteger(
      candidate.position,
      `${field} position`,
      Math.max(0, anchorChildIds.length - 1),
      'INVALID_PROPOSAL'
    );
    if (
      position <= previousPosition
      || anchorChildIds[position] !== itemId
      || seen.has(itemId)
    ) {
      fail(
        'INVALID_PROPOSAL',
        'Proposal existing sermon targets do not match the bound child order.'
      );
    }
    previousPosition = position;
    seen.add(itemId);
    if (
      !isRecord(candidate.textByChannel)
      || Object.keys(candidate.textByChannel).length < 1
      || Object.keys(candidate.textByChannel).some(channelId =>
        !projectChannelIds.includes(channelId))
    ) {
      fail(
        'INVALID_PROPOSAL',
        `${field} text does not match the project outputs.`
      );
    }
    const textByChannel = {};
    for (const [channelId, value] of Object.entries(
      candidate.textByChannel
    )) {
      const normalized = boundedText(
        value,
        `${field} ${channelId} text`,
        MAX_PROJECT_TEXT_CHARS,
        { code: 'INVALID_PROPOSAL' }
      );
      totalTextBytes += Buffer.byteLength(normalized, 'utf8');
      if (totalTextBytes > MAX_RECONCILIATION_TEXT_BYTES) {
        fail(
          'INVALID_PROPOSAL',
          'Proposal existing sermon text exceeds the safe review limit.'
        );
      }
      textByChannel[channelId] = normalized;
    }
    const sectionId = nullableIdentifier(
      candidate.sectionId,
      `${field} direct outline section`,
      'INVALID_PROPOSAL'
    );
    const effectiveSectionId = nullableIdentifier(
      candidate.effectiveSectionId,
      `${field} effective outline section`,
      'INVALID_PROPOSAL'
    );
    const sectionOwnerId = nullableIdentifier(
      candidate.sectionOwnerId,
      `${field} outline section owner`,
      'INVALID_PROPOSAL'
    );
    if (
      (effectiveSectionId === null) !== (sectionOwnerId === null)
      || (sectionId !== null && (
        effectiveSectionId !== sectionId
        || sectionOwnerId !== itemId
      ))
      || (sectionId === null && (
        effectiveSectionId !== anchor.effectiveSectionId
        || sectionOwnerId !== anchor.sectionOwnerId
      ))
    ) {
      fail(
        'INVALID_PROPOSAL',
        `${field} outline inheritance does not match the selected group.`
      );
    }
    targets.push({
      itemId,
      position,
      title: boundedText(
        candidate.title,
        `${field} title`,
        200,
        { code: 'INVALID_PROPOSAL' }
      ),
      presetId: identifier(
        candidate.presetId,
        `${field} preset`,
        'INVALID_PROPOSAL'
      ),
      sectionId,
      effectiveSectionId,
      sectionOwnerId,
      textByChannel,
      fingerprint: revision(
        candidate.fingerprint,
        `${field} fingerprint`,
        'INVALID_PROPOSAL'
      )
    });
  }
  return targets;
}

function normalizeProposalSource(raw, field) {
  exactKeys(raw, [
    'id',
    'kind',
    'fileName',
    'mediaType',
    'sha256',
    'languages'
  ], [], field, 'INVALID_PROPOSAL');
  const fileName = boundedText(
    raw.fileName,
    `${field} file name`,
    255,
    { code: 'INVALID_PROPOSAL' }
  );
  if (
    path.basename(fileName) !== fileName
    || fileName.includes('/')
    || fileName.includes('\\')
  ) {
    fail('INVALID_PROPOSAL', `${field} file name is not path-free.`);
  }
  if (raw.kind !== 'slide-notes' || raw.mediaType !== PPTX_MEDIA_TYPE) {
    fail('INVALID_PROPOSAL', `${field} is not a PowerPoint slide-notes source.`);
  }
  if (
    !Array.isArray(raw.languages)
    || raw.languages.length < 1
    || raw.languages.length > 8
  ) {
    fail('INVALID_PROPOSAL', `${field} languages are invalid.`);
  }
  const languages = raw.languages.map((language, index) => {
    if (typeof language !== 'string' || !LANGUAGE_PATTERN.test(language)) {
      fail('INVALID_PROPOSAL', `${field} language ${index + 1} is invalid.`);
    }
    return language;
  });
  if (new Set(languages).size !== languages.length) {
    fail('INVALID_PROPOSAL', `${field} languages contain duplicates.`);
  }
  return {
    id: identifier(raw.id, `${field} id`, 'INVALID_PROPOSAL'),
    kind: raw.kind,
    fileName,
    mediaType: raw.mediaType,
    sha256: revision(raw.sha256, `${field} revision`, 'INVALID_PROPOSAL'),
    languages
  };
}

function normalizeProposalChannelPool(raw, channelId) {
  const field = `Proposal source options for ${channelId}`;
  exactKeys(raw, [
    'channelId',
    'channelLabel',
    'channelLanguage',
    'source',
    'snapshotHash',
    'extractor',
    'window',
    'units'
  ], [], field, 'INVALID_PROPOSAL');
  if (raw.channelId !== channelId) {
    fail('INVALID_PROPOSAL', `${field} uses another channel id.`);
  }
  exactKeys(
    raw.extractor,
    ['id', 'version'],
    [],
    `${field} extractor`,
    'INVALID_PROPOSAL'
  );
  exactKeys(
    raw.window,
    ['startUnitId', 'endUnitId', 'startOrdinal', 'endOrdinal', 'unitCount'],
    [],
    `${field} window`,
    'INVALID_PROPOSAL'
  );
  if (
    !Array.isArray(raw.units)
    || raw.units.length < 1
    || raw.units.length > MAX_RECONCILIATION_ROWS
  ) {
    fail('INVALID_PROPOSAL', `${field} units are outside the safe row limit.`);
  }
  let totalTextBytes = 0;
  const unitIds = new Set();
  const units = raw.units.map((rawUnit, index) => {
    exactKeys(
      rawUnit,
      ['unitId', 'ordinal', 'label', 'text'],
      ['spans'],
      `${field} unit ${index + 1}`,
      'INVALID_PROPOSAL'
    );
    const unitId = identifier(
      rawUnit.unitId,
      `${field} unit ${index + 1} id`,
      'INVALID_PROPOSAL'
    );
    if (unitIds.has(unitId)) {
      fail('INVALID_PROPOSAL', `${field} repeats a source unit.`);
    }
    unitIds.add(unitId);
    const text = boundedText(
      rawUnit.text,
      `${field} unit ${index + 1} text`,
      MAX_PROJECT_TEXT_CHARS,
      { allowEmpty: true, code: 'INVALID_PROPOSAL' }
    );
    totalTextBytes += Buffer.byteLength(text, 'utf8');
    const spans = normalizeTrustedTextSpans(
      rawUnit.spans,
      text,
      `${field} unit ${index + 1} spans`,
      'INVALID_PROPOSAL'
    );
    return {
      unitId,
      ordinal: positiveInteger(
        rawUnit.ordinal,
        `${field} unit ${index + 1} ordinal`,
        MAX_RECONCILIATION_ROWS,
        'INVALID_PROPOSAL'
      ),
      label: boundedText(
        rawUnit.label,
        `${field} unit ${index + 1} label`,
        160,
        { code: 'INVALID_PROPOSAL' }
      ),
      text,
      ...(spans.length > 0 ? { spans } : {})
    };
  });
  const window = {
    startUnitId: identifier(
      raw.window.startUnitId,
      `${field} window start unit`,
      'INVALID_PROPOSAL'
    ),
    endUnitId: identifier(
      raw.window.endUnitId,
      `${field} window end unit`,
      'INVALID_PROPOSAL'
    ),
    startOrdinal: positiveInteger(
      raw.window.startOrdinal,
      `${field} window start ordinal`,
      MAX_RECONCILIATION_ROWS,
      'INVALID_PROPOSAL'
    ),
    endOrdinal: positiveInteger(
      raw.window.endOrdinal,
      `${field} window end ordinal`,
      MAX_RECONCILIATION_ROWS,
      'INVALID_PROPOSAL'
    ),
    unitCount: positiveInteger(
      raw.window.unitCount,
      `${field} window unit count`,
      MAX_RECONCILIATION_ROWS,
      'INVALID_PROPOSAL'
    )
  };
  if (
    window.unitCount !== units.length
    || window.startUnitId !== units[0].unitId
    || window.endUnitId !== units[units.length - 1].unitId
    || window.startOrdinal !== units[0].ordinal
    || window.endOrdinal !== units[units.length - 1].ordinal
  ) {
    fail('INVALID_PROPOSAL', `${field} window does not match its ordered units.`);
  }
  return {
    value: {
      channelId,
      channelLabel: boundedText(
        raw.channelLabel,
        `${field} channel label`,
        120,
        { code: 'INVALID_PROPOSAL' }
      ),
      channelLanguage: boundedText(
        raw.channelLanguage,
        `${field} channel language`,
        35,
        { code: 'INVALID_PROPOSAL' }
      ),
      source: normalizeProposalSource(raw.source, `${field} source`),
      snapshotHash: revision(
        raw.snapshotHash,
        `${field} snapshot hash`,
        'INVALID_PROPOSAL'
      ),
      extractor: {
        id: identifier(
          raw.extractor.id,
          `${field} extractor id`,
          'INVALID_PROPOSAL'
        ),
        version: positiveInteger(
          raw.extractor.version,
          `${field} extractor version`,
          1_000_000,
          'INVALID_PROPOSAL'
        )
      },
      window,
      units
    },
    totalTextBytes
  };
}

function normalizeSermonCueReconciliationProposal(raw) {
  exactKeys(raw, [
    'schemaVersion',
    'kind',
    'createdAt',
    'project',
    'anchor',
    'sermon',
    'channelIds',
    'unmappedChannelIds',
    'existingTargets',
    'sourceOptionsByChannel',
    'rows',
    'id'
  ], [], 'Sermon cue reconciliation proposal', 'INVALID_PROPOSAL');
  if (
    raw.schemaVersion !== SERMON_CUE_RECONCILIATION_SCHEMA_VERSION
    || raw.kind !== SERMON_CUE_RECONCILIATION_KIND
  ) {
    fail('INVALID_PROPOSAL', 'The sermon cue reconciliation proposal schema is unsupported.');
  }
  exactKeys(
    raw.project,
    ['id', 'revisionId', 'revision', 'updatedAt', 'planningStatus'],
    [],
    'Proposal project binding',
    'INVALID_PROPOSAL'
  );
  exactKeys(
    raw.anchor,
    [
      'itemId',
      'groupKind',
      'resourceId',
      'resourceOwnerId',
      'directSectionId',
      'effectiveSectionId',
      'sectionOwnerId',
      'childIds'
    ],
    [],
    'Proposal anchor binding',
    'INVALID_PROPOSAL'
  );
  exactKeys(
    raw.sermon,
    ['id', 'revisionId'],
    [],
    'Proposal sermon binding',
    'INVALID_PROPOSAL'
  );
  const channelIds = normalizedIdentifierList(
    raw.channelIds,
    'Proposal channel ids',
    MAX_RECONCILIATION_CHANNELS,
    'INVALID_PROPOSAL'
  );
  if (channelIds.length < 1) {
    fail('INVALID_PROPOSAL', 'The proposal must include at least one mapped channel.');
  }
  const unmappedChannelIds = normalizedIdentifierList(
    raw.unmappedChannelIds,
    'Proposal unmapped channel ids',
    MAX_RECONCILIATION_CHANNELS,
    'INVALID_PROPOSAL'
  );
  if (unmappedChannelIds.some(channelId => channelIds.includes(channelId))) {
    fail('INVALID_PROPOSAL', 'Mapped and unmapped proposal channels overlap.');
  }
  const projectChannelIds = [...channelIds, ...unmappedChannelIds];
  const anchorItemId = identifier(
    raw.anchor.itemId,
    'Proposal anchor item id',
    'INVALID_PROPOSAL'
  );
  if (!SERMON_RECONCILIATION_GROUP_KINDS.includes(raw.anchor.groupKind)) {
    fail(
      'INVALID_PROPOSAL',
      'Proposal anchor group kind is not a semantic sermon outline group.'
    );
  }
  const directSectionId = nullableIdentifier(
    raw.anchor.directSectionId,
    'Proposal anchor direct outline section',
    'INVALID_PROPOSAL'
  );
  const effectiveSectionId = nullableIdentifier(
    raw.anchor.effectiveSectionId,
    'Proposal anchor effective outline section',
    'INVALID_PROPOSAL'
  );
  const sectionOwnerId = nullableIdentifier(
    raw.anchor.sectionOwnerId,
    'Proposal anchor outline section owner',
    'INVALID_PROPOSAL'
  );
  if (
    (effectiveSectionId === null) !== (sectionOwnerId === null)
    || (directSectionId !== null && (
      directSectionId !== effectiveSectionId
      || sectionOwnerId !== anchorItemId
    ))
  ) {
    fail(
      'INVALID_PROPOSAL',
      'Proposal anchor outline inheritance is inconsistent.'
    );
  }
  const anchorChildIds = normalizedIdentifierList(
    raw.anchor.childIds,
    'Proposal anchor child ids',
    MAX_RECONCILIATION_EXISTING_CHILDREN,
    'INVALID_PROPOSAL'
  );
  const anchorBinding = {
    itemId: anchorItemId,
    groupKind: raw.anchor.groupKind,
    resourceId: boundedText(
      raw.anchor.resourceId,
      'Proposal sermon resource id',
      80,
      { code: 'INVALID_PROPOSAL' }
    ),
    resourceOwnerId: identifier(
      raw.anchor.resourceOwnerId,
      'Proposal sermon resource owner',
      'INVALID_PROPOSAL'
    ),
    directSectionId,
    effectiveSectionId,
    sectionOwnerId,
    childIds: anchorChildIds
  };
  const existingTargets = normalizeExistingTargets(
    raw.existingTargets,
    anchorBinding,
    projectChannelIds
  );
  if (
    !isRecord(raw.sourceOptionsByChannel)
    || Object.keys(raw.sourceOptionsByChannel).length !== channelIds.length
    || Object.keys(raw.sourceOptionsByChannel).some(channelId =>
      !channelIds.includes(channelId))
  ) {
    fail(
      'INVALID_PROPOSAL',
      'Proposal source options do not exactly match its mapped channels.'
    );
  }
  const sourceOptionsByChannel = {};
  let totalTextBytes = 0;
  for (const channelId of channelIds) {
    const normalized = normalizeProposalChannelPool(
      raw.sourceOptionsByChannel[channelId],
      channelId
    );
    sourceOptionsByChannel[channelId] = normalized.value;
    totalTextBytes += normalized.totalTextBytes;
    if (totalTextBytes > MAX_RECONCILIATION_TEXT_BYTES) {
      fail('INVALID_PROPOSAL', 'Proposal source text exceeds the safe aggregate limit.');
    }
  }

  const slotCount = Math.max(...channelIds.map(channelId =>
    sourceOptionsByChannel[channelId].units.length));
  if (
    !Array.isArray(raw.rows)
    || raw.rows.length !== slotCount
    || raw.rows.length > MAX_RECONCILIATION_ROWS
  ) {
    fail('INVALID_PROPOSAL', 'Proposal rows do not match the bounded source windows.');
  }
  const seenUnitsByChannel = Object.fromEntries(
    channelIds.map(channelId => [channelId, new Set()])
  );
  const rows = raw.rows.map((rawRow, index) => {
    const field = `Proposal row ${index + 1}`;
    exactKeys(rawRow, [
      'id',
      'ordinal',
      'relativePosition',
      'suggested',
      'suggestionsByChannel',
      'unmatchedChannelIds'
    ], [], field, 'INVALID_PROPOSAL');
    exactKeys(
      rawRow.relativePosition,
      ['slot', 'slotCount'],
      [],
      `${field} relative position`,
      'INVALID_PROPOSAL'
    );
    const rowId = identifier(rawRow.id, `${field} id`, 'INVALID_PROPOSAL');
    const ordinal = positiveInteger(
      rawRow.ordinal,
      `${field} ordinal`,
      MAX_RECONCILIATION_ROWS,
      'INVALID_PROPOSAL'
    );
    if (
      rowId !== `row-${String(index + 1).padStart(3, '0')}`
      || ordinal !== index + 1
      || rawRow.relativePosition.slot !== index + 1
      || rawRow.relativePosition.slotCount !== slotCount
      || rawRow.suggested !== true
    ) {
      fail('INVALID_PROPOSAL', `${field} has inconsistent suggestion ordering.`);
    }
    if (
      !isRecord(rawRow.suggestionsByChannel)
      || Object.keys(rawRow.suggestionsByChannel).length !== channelIds.length
      || Object.keys(rawRow.suggestionsByChannel).some(channelId =>
        !channelIds.includes(channelId))
    ) {
      fail('INVALID_PROPOSAL', `${field} suggestions do not match mapped channels.`);
    }
    const suggestionsByChannel = {};
    const expectedUnmatched = [];
    for (const channelId of channelIds) {
      const rawSuggestion = rawRow.suggestionsByChannel[channelId];
      if (rawSuggestion === null) {
        suggestionsByChannel[channelId] = null;
        expectedUnmatched.push(channelId);
        continue;
      }
      exactKeys(rawSuggestion, [
        'unitId',
        'label',
        'text',
        'suggested'
      ], [], `${field} ${channelId} suggestion`, 'INVALID_PROPOSAL');
      const unitId = identifier(
        rawSuggestion.unitId,
        `${field} ${channelId} unit id`,
        'INVALID_PROPOSAL'
      );
      const unit = sourceOptionsByChannel[channelId].units.find(candidate =>
        candidate.unitId === unitId);
      if (
        !unit
        || unit.label !== rawSuggestion.label
        || unit.text !== rawSuggestion.text
        || rawSuggestion.suggested !== true
        || seenUnitsByChannel[channelId].has(unitId)
      ) {
        fail(
          'INVALID_PROPOSAL',
          `${field} ${channelId} suggestion is not an exact unused source option.`
        );
      }
      seenUnitsByChannel[channelId].add(unitId);
      suggestionsByChannel[channelId] = {
        unitId,
        label: unit.label,
        text: unit.text,
        suggested: true
      };
    }
    const unmatchedChannelIds = normalizedIdentifierList(
      rawRow.unmatchedChannelIds,
      `${field} unmatched channels`,
      channelIds.length,
      'INVALID_PROPOSAL'
    );
    if (!sameStringList(unmatchedChannelIds, expectedUnmatched)) {
      fail('INVALID_PROPOSAL', `${field} unmatched channels are inconsistent.`);
    }
    return {
      id: rowId,
      ordinal,
      relativePosition: { slot: index + 1, slotCount },
      suggested: true,
      suggestionsByChannel,
      unmatchedChannelIds
    };
  });
  for (const channelId of channelIds) {
    if (
      seenUnitsByChannel[channelId].size
      !== sourceOptionsByChannel[channelId].units.length
    ) {
      fail(
        'INVALID_PROPOSAL',
        `Proposal rows silently omit a source option for ${channelId}.`
      );
    }
  }

  const normalized = {
    schemaVersion: SERMON_CUE_RECONCILIATION_SCHEMA_VERSION,
    kind: SERMON_CUE_RECONCILIATION_KIND,
    createdAt: canonicalTimestamp(
      raw.createdAt,
      'Proposal creation time',
      'INVALID_PROPOSAL'
    ),
    project: {
      id: identifier(raw.project.id, 'Proposal project id', 'INVALID_PROPOSAL'),
      revisionId: revision(
        raw.project.revisionId,
        'Proposal project revision',
        'INVALID_PROPOSAL'
      ),
      revision: nonNegativeInteger(
        raw.project.revision,
        'Proposal project revision number',
        Number.MAX_SAFE_INTEGER,
        'INVALID_PROPOSAL'
      ),
      updatedAt: canonicalTimestamp(
        raw.project.updatedAt,
        'Proposal project update time',
        'INVALID_PROPOSAL'
      ),
      planningStatus: raw.project.planningStatus === null
        ? null
        : identifier(
            raw.project.planningStatus,
            'Proposal planning status',
            'INVALID_PROPOSAL'
          )
    },
    anchor: anchorBinding,
    sermon: {
      id: identifier(raw.sermon.id, 'Proposal sermon id', 'INVALID_PROPOSAL'),
      revisionId: revision(
        raw.sermon.revisionId,
        'Proposal sermon revision',
        'INVALID_PROPOSAL'
      )
    },
    channelIds,
    unmappedChannelIds,
    existingTargets,
    sourceOptionsByChannel,
    rows
  };
  const id = revision(raw.id, 'Proposal id', 'INVALID_PROPOSAL');
  if (canonicalHash(normalized) !== id) {
    fail('INVALID_PROPOSAL', 'The sermon cue reconciliation proposal was changed after review.');
  }
  return deepFreeze({ ...normalized, id });
}

function validateProposalAgainstProject(
  project,
  proposal,
  { validateExistingTargets = false } = {}
) {
  if (project.id !== proposal.project.id) {
    fail(
      'PROPOSAL_BINDING_MISMATCH',
      'The proposal belongs to another service project.'
    );
  }
  const { anchor, linked } = requireSermonCueReconciliationAnchor(
    project,
    proposal.anchor.itemId,
    proposal.sermon.id,
    proposal.sermon.revisionId
  );
  const currentAnchorBinding = sermonCueAnchorBinding(anchor, linked);
  const {
    childIds: currentAnchorChildIds,
    ...currentStaticAnchorBinding
  } = currentAnchorBinding;
  const {
    childIds: proposalAnchorChildIds,
    ...proposalStaticAnchorBinding
  } = proposal.anchor;
  if (
    canonicalJson(currentStaticAnchorBinding)
    !== canonicalJson(proposalStaticAnchorBinding)
  ) {
    fail(
      'PROPOSAL_BINDING_MISMATCH',
      'The selected sermon outline group binding changed.'
    );
  }
  if (validateExistingTargets) {
    const existingTargets = existingTargetsForAnchor(
      project,
      anchor,
      linked,
      { code: 'PROPOSAL_BINDING_MISMATCH' }
    );
    if (
      !sameStringList(currentAnchorChildIds, proposalAnchorChildIds)
      || canonicalJson(existingTargets)
        !== canonicalJson(proposal.existingTargets)
    ) {
      fail(
        'PROPOSAL_BINDING_MISMATCH',
        'The sermon tree changed after reconciliation review.'
      );
    }
  }
  const expectedChannelIds = project.channelIds.filter(channelId =>
    proposal.channelIds.includes(channelId));
  const expectedUnmapped = project.channelIds.filter(channelId =>
    !proposal.channelIds.includes(channelId));
  if (
    !sameStringList(expectedChannelIds, proposal.channelIds)
    || !sameStringList(expectedUnmapped, proposal.unmappedChannelIds)
  ) {
    fail(
      'PROPOSAL_BINDING_MISMATCH',
      'The service output channels changed after reconciliation review.'
    );
  }
  for (const channelId of proposal.channelIds) {
    const pool = proposal.sourceOptionsByChannel[channelId];
    const channel = project.channels[channelId];
    const source = linked.resource.document.sources.find(candidate =>
      candidate.id === pool.source.id);
    if (
      !channel
      || channel.label !== pool.channelLabel
      || channel.language !== pool.channelLanguage
      || !source
      || source.kind !== pool.source.kind
      || source.fileName !== pool.source.fileName
      || source.mediaType !== pool.source.mediaType
      || source.sha256 !== pool.source.sha256
      || !sameStringList(
        normalizedSourceLanguages(source),
        pool.source.languages
      )
    ) {
      fail(
        'PROPOSAL_BINDING_MISMATCH',
        'A mapped output or sermon source changed after reconciliation review.',
        { channelId, sourceId: pool.source.id }
      );
    }
  }
  return { anchor, linked };
}

function normalizeDecisionSelection(
  raw,
  channelId,
  pool,
  rowField,
  usedUnitIds
) {
  if (raw === null) return null;
  exactKeys(
    raw,
    ['unitId', 'text'],
    [],
    `${rowField} ${channelId} selection`,
    'INVALID_DECISIONS'
  );
  const unitId = identifier(
    raw.unitId,
    `${rowField} ${channelId} selected unit`,
    'INVALID_DECISIONS'
  );
  const unit = pool.units.find(candidate => candidate.unitId === unitId);
  if (!unit) {
    fail(
      'UNKNOWN_SOURCE_UNIT',
      'A reconciliation decision selected a unit outside that output source window.',
      { channelId, unitId }
    );
  }
  if (typeof raw.text !== 'string' || raw.text !== unit.text) {
    fail(
      'SOURCE_UNIT_TEXT_MISMATCH',
      'Selected sermon cue text must remain byte-for-byte equal to its source unit.',
      { channelId, unitId }
    );
  }
  if (usedUnitIds.has(unitId)) {
    fail(
      'SOURCE_UNIT_REUSED',
      'One source unit cannot seed more than one cue in the same output channel.',
      { channelId, unitId }
    );
  }
  usedUnitIds.add(unitId);
  return { unitId, text: unit.text };
}

function normalizeDecisions(rawDecisions, proposal, sermon) {
  if (
    !Array.isArray(rawDecisions)
    || rawDecisions.length !== proposal.rows.length
    || rawDecisions.length > MAX_RECONCILIATION_ROWS
  ) {
    fail(
      'MISSING_ROW_DECISION',
      'Choose Insert, Update, or Skip explicitly for every reconciliation row.'
    );
  }
  const rawByRowId = new Map();
  for (const [index, rawDecision] of rawDecisions.entries()) {
    exactKeys(rawDecision, [
      'rowId',
      'action',
      'sectionId',
      'unitsByChannel'
    ], ['targetItemId'], `Reconciliation decision ${index + 1}`, 'INVALID_DECISIONS');
    const rowId = identifier(
      rawDecision.rowId,
      `Reconciliation decision ${index + 1} row`,
      'INVALID_DECISIONS'
    );
    if (rawByRowId.has(rowId)) {
      fail('DUPLICATE_ROW_DECISION', 'A reconciliation row was decided more than once.', {
        rowId
      });
    }
    rawByRowId.set(rowId, rawDecision);
  }
  if (
    rawByRowId.size !== proposal.rows.length
    || proposal.rows.some(row => !rawByRowId.has(row.id))
  ) {
    fail(
      'MISSING_ROW_DECISION',
      'Choose Insert, Update, or Skip explicitly for every reconciliation row.'
    );
  }

  const outlineIds = new Set(sermon.outline.map(section => section.id));
  const usedByChannel = Object.fromEntries(
    proposal.channelIds.map(channelId => [channelId, new Set()])
  );
  const existingTargetsById = new Map(
    proposal.existingTargets.map(target => [target.itemId, target])
  );
  const usedTargetIds = new Set();
  return proposal.rows.map(row => {
    const raw = rawByRowId.get(row.id);
    if (!['insert', 'update', 'skip'].includes(raw.action)) {
      fail(
        'INVALID_DECISIONS',
        'A reconciliation row action must be insert, update, or skip.',
        { rowId: row.id }
      );
    }
    const targetItemId = raw.targetItemId === undefined
      || raw.targetItemId === null
      ? null
      : identifier(
          raw.targetItemId,
          `Reconciliation row ${row.id} existing cue`,
          'INVALID_DECISIONS'
        );
    if (raw.action === 'update') {
      if (!targetItemId || !existingTargetsById.has(targetItemId)) {
        fail(
          'UNKNOWN_EXISTING_TARGET',
          'Choose one eligible existing sermon cue for every Update decision.',
          { rowId: row.id, targetItemId }
        );
      }
      if (usedTargetIds.has(targetItemId)) {
        fail(
          'EXISTING_TARGET_REUSED',
          'One existing sermon cue cannot be updated by more than one reviewed row.',
          { rowId: row.id, targetItemId }
        );
      }
      usedTargetIds.add(targetItemId);
    } else if (targetItemId !== null) {
      fail(
        'INVALID_DECISIONS',
        'Only an Update decision can select an existing sermon cue.',
        { rowId: row.id, targetItemId }
      );
    }
    const sectionId = raw.sectionId === null
      ? null
      : identifier(
          raw.sectionId,
          `Reconciliation row ${row.id} outline section`,
          'INVALID_DECISIONS'
        );
    if (sectionId && !outlineIds.has(sectionId)) {
      fail(
        'UNKNOWN_OUTLINE_SECTION',
        'A reconciliation row selected an outline section outside the pinned sermon.',
        { rowId: row.id, sectionId }
      );
    }
    if (
      !isRecord(raw.unitsByChannel)
      || Object.keys(raw.unitsByChannel).length !== proposal.channelIds.length
      || Object.keys(raw.unitsByChannel).some(channelId =>
        !proposal.channelIds.includes(channelId))
    ) {
      fail(
        'INVALID_DECISIONS',
        'Each row must explicitly choose or unpair a unit for every mapped output.',
        { rowId: row.id }
      );
    }
    const unitsByChannel = {};
    for (const channelId of proposal.channelIds) {
      unitsByChannel[channelId] = normalizeDecisionSelection(
        raw.unitsByChannel[channelId],
        channelId,
        proposal.sourceOptionsByChannel[channelId],
        `Reconciliation row ${row.id}`,
        usedByChannel[channelId]
      );
    }
    const selected = Object.values(unitsByChannel).filter(Boolean);
    if (raw.action === 'skip') {
      if (sectionId !== null || selected.length > 0) {
        fail(
          'INVALID_DECISIONS',
          'A skipped reconciliation row cannot retain source units or an outline section.',
          { rowId: row.id }
        );
      }
    } else if (
      selected.length < 1
      || !selected.some(selection => selection.text.length > 0)
    ) {
      fail(
        'EMPTY_INSERT',
        'An inserted or updated reconciliation row needs at least one non-empty exact source unit.',
        { rowId: row.id }
      );
    }
    return {
      rowId: row.id,
      action: raw.action,
      targetItemId,
      sectionId,
      unitsByChannel
    };
  });
}

function titleForDecision(decision, proposal, sermon) {
  if (decision.sectionId) {
    const section = sermon.outline.find(candidate =>
      candidate.id === decision.sectionId);
    return section.titles[sermon.defaultLanguage]
      || Object.values(section.titles)[0];
  }
  for (const channelId of proposal.channelIds) {
    const selection = decision.unitsByChannel[channelId];
    if (!selection) continue;
    const unit = proposal.sourceOptionsByChannel[channelId].units.find(candidate =>
      candidate.unitId === selection.unitId);
    if (!unit) continue;
    const meaningfulLine = unit.text
      .split(/\r\n?|\n/u)
      .map(line => line.trim())
      .find(Boolean);
    if (!meaningfulLine) continue;
    let bounded = meaningfulLine.slice(0, 200);
    if (
      bounded.length > 0
      && bounded.charCodeAt(bounded.length - 1) >= 0xD800
      && bounded.charCodeAt(bounded.length - 1) <= 0xDBFF
    ) {
      bounded = bounded.slice(0, -1);
    }
    if (bounded.length > 0) return bounded;
  }
  return 'Sermon note';
}

function joinTrustedSourceUnits(units, separator = '\n\n') {
  let text = '';
  const spans = [];
  for (const [index, unit] of units.entries()) {
    if (index > 0) text += separator;
    const offset = text.length;
    text += unit.text;
    if (text.length > MAX_PROJECT_TEXT_CHARS) {
      fail(
        'SOURCE_UNIT_TOO_LARGE',
        'Combined source units are too large to preserve as one native sermon cue.',
        { maximum: MAX_PROJECT_TEXT_CHARS }
      );
    }
    const trustedSpans = normalizeTrustedTextSpans(
      unit.spans,
      unit.text,
      `Trusted proposal unit ${unit.unitId} spans`,
      'INVALID_PROPOSAL'
    );
    if (spans.length + trustedSpans.length > MAX_TEXT_SPANS) {
      fail(
        'INVALID_PROPOSAL',
        'Combined source units contain too many inline formatting ranges.',
        { maximum: MAX_TEXT_SPANS }
      );
    }
    for (const span of trustedSpans) {
      spans.push({
        ...span,
        start: offset + span.start,
        end: offset + span.end
      });
    }
  }
  return { text, spans };
}

function createItemPlans(project, proposal, decisions, idFactory, sermon) {
  const seenIds = new Set();
  return decisions
    .filter(decision => decision.action !== 'skip')
    .map((decision, index) => {
      let itemId;
      if (decision.action === 'update') {
        itemId = decision.targetItemId;
      } else {
        let rawItemId;
        try {
          rawItemId = idFactory({
            proposalId: proposal.id,
            rowId: decision.rowId,
            ordinal: index + 1
          });
        } catch (error) {
          fail(
            'INVALID_ITEM_ID',
            'The sermon cue identity generator failed.',
            { cause: error?.message || null }
          );
        }
        itemId = identifier(
          rawItemId,
          `Generated sermon cue id for ${decision.rowId}`,
          'INVALID_ITEM_ID'
        );
        if (seenIds.has(itemId)) {
          fail(
            'DUPLICATE_ITEM_ID',
            'The sermon cue identity generator returned a duplicate id.',
            { itemId }
          );
        }
        seenIds.add(itemId);
      }
      const existingItem = decision.action === 'update'
        ? project.items[itemId]
        : null;
      if (
        decision.action === 'update'
        && (!existingItem || existingItem.kind !== 'sermon')
      ) {
        fail(
          'UNKNOWN_EXISTING_TARGET',
          'A reviewed existing sermon cue no longer exists.',
          { itemId }
        );
      }
      const textByChannel = {};
      const spansByChannel = {};
      const titlesByChannel = {};
      if (existingItem) {
        for (const channelId of proposal.unmappedChannelIds) {
          if (existingItem.titlesByChannel?.[channelId]) {
            titlesByChannel[channelId] =
              existingItem.titlesByChannel[channelId];
          }
          if (!Object.prototype.hasOwnProperty.call(
            existingItem.textByChannel,
            channelId
          )) {
            continue;
          }
          textByChannel[channelId] =
            existingItem.textByChannel[channelId];
          if (existingItem.spansByChannel?.[channelId]) {
            spansByChannel[channelId] = deepClone(
              existingItem.spansByChannel[channelId]
            );
          }
        }
      }
      for (const channelId of proposal.channelIds) {
        const selection = decision.unitsByChannel[channelId];
        if (!selection) continue;
        const pool = proposal.sourceOptionsByChannel[channelId];
        const unit = pool.units.find(candidate =>
          candidate.unitId === selection.unitId);
        if (!unit) {
          fail(
            'UNKNOWN_SOURCE_UNIT',
            'A reviewed sermon cue selection no longer resolves to its trusted proposal unit.',
            { channelId, unitId: selection.unitId }
          );
        }
        const content = joinTrustedSourceUnits([unit]);
        if (content.text.length > 0) {
          textByChannel[channelId] = content.text;
          if (content.spans.length > 0) {
            spansByChannel[channelId] = content.spans;
          }
        }
      }
      if (Object.keys(textByChannel).length < 1) {
        fail(
          'EMPTY_UPDATE',
          'An updated sermon cue must retain or select at least one non-empty output.',
          { itemId, rowId: decision.rowId }
        );
      }
      const rawItem = {
        ...(existingItem ? deepClone(existingItem) : {}),
        id: itemId,
        kind: 'sermon',
        title: existingItem
          ? existingItem.title
          : titleForDecision(decision, proposal, sermon),
        textByChannel,
        ...(existingItem ? {} : {
          presetId: 'sermon-notes',
          operatorNotes: '',
          createdAt: proposal.createdAt
        }),
        updatedAt: proposal.createdAt
      };
      if (Object.keys(spansByChannel).length > 0) {
        rawItem.spansByChannel = spansByChannel;
      } else {
        delete rawItem.spansByChannel;
      }
      if (Object.keys(titlesByChannel).length > 0) {
        rawItem.titlesByChannel = titlesByChannel;
      } else {
        delete rawItem.titlesByChannel;
      }
      if (decision.sectionId) {
        rawItem.sermonSectionId = decision.sectionId;
      } else {
        delete rawItem.sermonSectionId;
      }
      return {
        decision,
        itemId,
        rawItem,
        mode: decision.action
      };
    });
}

function normalizePlacementIndex(raw, childCount) {
  if (raw === undefined && childCount === 0) return 0;
  if (!Number.isSafeInteger(raw) || raw < 0 || raw > childCount) {
    fail(
      childCount > 0 ? 'PLACEMENT_REQUIRED' : 'INVALID_PLACEMENT',
      childCount > 0
        ? 'Choose where the reviewed sermon-slide block belongs among the selected group’s direct children.'
        : 'The reviewed sermon-slide placement is invalid.',
      { childCount }
    );
  }
  return raw;
}

function applyItemPlans(baseProject, proposal, itemPlans, placementIndex) {
  const raw = JSON.parse(serializeServiceProject(baseProject));
  const anchor = raw.items[proposal.anchor.itemId];
  if (
    !anchor
    || anchor.kind !== 'group'
    || !sameStringList(anchor.childIds, proposal.anchor.childIds)
  ) {
    fail(
      'PROJECT_REVISION_MISMATCH',
      'The selected group order changed after reconciliation review.'
    );
  }

  const updatedIds = new Set(
    itemPlans
      .filter(plan => plan.mode === 'update')
      .map(plan => plan.itemId)
  );
  for (const plan of itemPlans) {
    if (plan.mode === 'insert' && raw.items[plan.itemId]) {
      fail(
        'DUPLICATE_ITEM_ID',
        'A generated sermon cue id already exists in the service project.',
        { itemId: plan.itemId }
      );
    }
    if (plan.mode === 'update' && !raw.items[plan.itemId]) {
      fail(
        'UNKNOWN_EXISTING_TARGET',
        'A reviewed existing sermon cue no longer exists.',
        { itemId: plan.itemId }
      );
    }
    raw.items[plan.itemId] = deepClone(plan.rawItem);
  }

  const remainingChildIds = proposal.anchor.childIds.filter(itemId =>
    !updatedIds.has(itemId));
  const adjustedPlacement = proposal.anchor.childIds
    .slice(0, placementIndex)
    .filter(itemId => !updatedIds.has(itemId))
    .length;
  remainingChildIds.splice(
    adjustedPlacement,
    0,
    ...itemPlans.map(plan => plan.itemId)
  );
  anchor.childIds = remainingChildIds;
  if (raw.planning) {
    raw.planning.status = 'planning';
    delete raw.planning.readinessWaivers;
  }

  try {
    return normalizeServiceProject(raw);
  } catch (error) {
    fail(
      error?.code === 'DUPLICATE_ITEM_ID'
        ? 'DUPLICATE_ITEM_ID'
        : 'PROJECT_MUTATION_FAILED',
      'The reviewed sermon cue rows could not form a valid native service project.',
      { causeCode: error?.code || null }
    );
  }
}

function reconstructionBase(current, proposal, itemPlans) {
  if (proposal.anchor.childIds.length > 0) return null;
  const intendedIds = itemPlans.map(plan => plan.itemId);
  const anchor = current.items[proposal.anchor.itemId];
  if (!sameStringList(anchor.childIds, intendedIds)) return null;
  if (intendedIds.some(itemId => !current.items[itemId])) return null;

  const raw = JSON.parse(serializeServiceProject(current));
  for (const itemId of intendedIds) delete raw.items[itemId];
  raw.items[proposal.anchor.itemId].childIds = [];
  raw.revision = proposal.project.revision;
  raw.updatedAt = proposal.project.updatedAt;
  if (raw.planning) raw.planning.status = proposal.project.planningStatus;
  let base;
  try {
    base = normalizeServiceProject(raw);
  } catch (_error) {
    return null;
  }
  if (serviceProjectRevisionId(base) !== proposal.project.revisionId) return null;
  return base;
}

function equivalentAppliedProject(current, expected) {
  const raw = JSON.parse(serializeServiceProject(current));
  raw.revision = expected.revision;
  raw.updatedAt = expected.updatedAt;
  let normalized;
  try {
    normalized = normalizeServiceProject(raw);
  } catch (_error) {
    return false;
  }
  return serializeServiceProject(normalized) === serializeServiceProject(expected);
}

function receiptFor(proposal, decisions, itemPlans, placementIndex) {
  const itemIdByRowId = new Map(itemPlans.map(plan => [
    plan.decision.rowId,
    plan.itemId
  ]));
  return {
    schemaVersion: SERMON_CUE_RECONCILIATION_RECEIPT_SCHEMA_VERSION,
    kind: SERMON_CUE_RECONCILIATION_RECEIPT_KIND,
    proposalId: proposal.id,
    projectId: proposal.project.id,
    baseProjectRevisionId: proposal.project.revisionId,
    anchorItemId: proposal.anchor.itemId,
    anchorGroupKind: proposal.anchor.groupKind,
    anchorResourceId: proposal.anchor.resourceId,
    anchorResourceOwnerId: proposal.anchor.resourceOwnerId,
    anchorDirectSectionId: proposal.anchor.directSectionId,
    anchorEffectiveSectionId: proposal.anchor.effectiveSectionId,
    anchorSectionOwnerId: proposal.anchor.sectionOwnerId,
    placementIndex,
    sermonId: proposal.sermon.id,
    sermonRevisionId: proposal.sermon.revisionId,
    sourceBindings: proposal.channelIds.map(channelId => {
      const pool = proposal.sourceOptionsByChannel[channelId];
      return {
        channelId,
        sourceId: pool.source.id,
        sourceRevision: pool.source.sha256,
        snapshotHash: pool.snapshotHash,
        extractorId: pool.extractor.id,
        extractorVersion: pool.extractor.version
      };
    }),
    decisions: decisions.map(decision => ({
      rowId: decision.rowId,
      action: decision.action,
      targetItemId: decision.targetItemId,
      sectionId: decision.sectionId,
      unitsByChannel: decision.unitsByChannel,
      itemId: itemIdByRowId.get(decision.rowId) || null
    })),
    insertedItemIds: itemPlans
      .filter(plan => plan.mode === 'insert')
      .map(plan => plan.itemId),
    updatedItemIds: itemPlans
      .filter(plan => plan.mode === 'update')
      .map(plan => plan.itemId),
    managedItemIds: itemPlans.map(plan => plan.itemId),
    skippedRowIds: decisions
      .filter(decision => decision.action === 'skip')
      .map(decision => decision.rowId)
  };
}

function applySermonCueReconciliation(options = {}) {
  exactKeys(options, [
    'project',
    'proposal',
    'decisions',
    'confirmed',
    'idFactory'
  ], ['placementIndex'], 'Sermon cue reconciliation apply request', 'INVALID_RECONCILIATION_REQUEST');
  if (options.confirmed !== true) {
    fail(
      'CONFIRMATION_REQUIRED',
      'Confirm every reviewed reconciliation decision before applying sermon cues.'
    );
  }
  if (typeof options.idFactory !== 'function') {
    fail(
      'INVALID_ITEM_ID',
      'Sermon cue reconciliation requires an item identity factory.'
    );
  }

  const proposal = normalizeSermonCueReconciliationProposal(options.proposal);
  const project = canonicalProject(options.project);
  const currentRevisionId = serviceProjectRevisionId(project);
  const { linked } = validateProposalAgainstProject(project, proposal, {
    validateExistingTargets:
      currentRevisionId === proposal.project.revisionId
  });
  const decisions = normalizeDecisions(
    options.decisions,
    proposal,
    linked.resource.document
  );
  const itemPlans = createItemPlans(
    project,
    proposal,
    decisions,
    options.idFactory,
    linked.resource.document
  );
  const placementIndex = itemPlans.length === 0
    ? null
    : normalizePlacementIndex(
        options.placementIndex,
        proposal.anchor.childIds.length
      );
  const receipt = receiptFor(
    proposal,
    decisions,
    itemPlans,
    placementIndex
  );

  if (currentRevisionId === proposal.project.revisionId) {
    if (itemPlans.length === 0) {
      return deepFreeze({
        changed: false,
        unchanged: true,
        project,
        insertedItemIds: [],
        updatedItemIds: [],
        reorderedItemIds: [],
        skippedRowIds: receipt.skippedRowIds,
        receipt
      });
    }
    const next = applyItemPlans(
      project,
      proposal,
      itemPlans,
      placementIndex
    );
    const nextChildren = next.items[proposal.anchor.itemId].childIds;
    const reorderedItemIds = receipt.updatedItemIds.filter(itemId =>
      proposal.anchor.childIds.indexOf(itemId)
        !== nextChildren.indexOf(itemId));
    return deepFreeze({
      changed: true,
      unchanged: false,
      project: next,
      insertedItemIds: receipt.insertedItemIds,
      updatedItemIds: receipt.updatedItemIds,
      reorderedItemIds,
      skippedRowIds: receipt.skippedRowIds,
      receipt
    });
  }

  // A caller may retry after the first exact result was saved. Reconstruct the
  // bound empty base and accept only the byte-equivalent applied result. Any
  // unrelated edit still fails closed as a stale project.
  const reconstructed = reconstructionBase(project, proposal, itemPlans);
  if (reconstructed) {
    const expected = applyItemPlans(
      reconstructed,
      proposal,
      itemPlans,
      placementIndex
    );
    if (equivalentAppliedProject(project, expected)) {
      return deepFreeze({
        changed: false,
        unchanged: true,
        project,
        insertedItemIds: receipt.insertedItemIds,
        updatedItemIds: receipt.updatedItemIds,
        reorderedItemIds: [],
        skippedRowIds: receipt.skippedRowIds,
        receipt
      });
    }
  }
  fail(
    'PROJECT_REVISION_MISMATCH',
    'The service project changed after reconciliation review.'
  );
}

module.exports = {
  MAX_PROJECT_TEXT_CHARS,
  MAX_RECONCILIATION_CHANNELS,
  MAX_RECONCILIATION_ROWS,
  MAX_RECONCILIATION_TEXT_BYTES,
  SERMON_CUE_RECONCILIATION_KIND,
  SERMON_CUE_RECONCILIATION_RECEIPT_KIND,
  SERMON_CUE_RECONCILIATION_RECEIPT_SCHEMA_VERSION,
  SERMON_CUE_RECONCILIATION_SCHEMA_VERSION,
  SermonCueReconciliationError,
  applySermonCueReconciliation,
  buildSermonCueReconciliationProposal,
  normalizeSermonCueReconciliationProposal,
  requireSermonCueReconciliationAnchor,
  serviceProjectRevisionId
};
