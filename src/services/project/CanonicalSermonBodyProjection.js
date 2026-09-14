'use strict';

const crypto = require('crypto');

const {
  SOURCE_BODY_PROJECTION_KIND,
  SOURCE_BODY_PROJECTION_SCHEMA_VERSION,
  SOURCE_BODY_PROJECTION_SCHEMA_VERSION_V2,
  normalizeServiceProject,
  resolveSermonSourceLink,
  serializeServiceProject,
  sermonBodyEntryRevisionId,
  sermonBodyParagraphCandidates
} = require('./ServiceProject');
const {
  requireSermonCueReconciliationAnchor,
  serviceProjectRevisionId
} = require('./SermonCueReconciliation');

const CANONICAL_SERMON_BODY_PROJECTION_SCHEMA_VERSION = 1;
const CANONICAL_SERMON_BODY_PROJECTION_KIND =
  'syncshow-canonical-sermon-body-projection-proposal';
const MAX_BODY_PROJECTION_CHANNELS = 32;
const MAX_BODY_PROJECTION_PARAGRAPHS = 256;
const MAX_BODY_PROJECTION_CANDIDATES = 1024;
const MAX_BODY_PROJECTION_ROWS = 512;
const MAX_BODY_PROJECTION_EXISTING_CHILDREN = 256;
const MAX_BODY_PROJECTION_TEXT_CHARS = 20_000;
const MAX_BODY_PROJECTION_TEXT_BYTES = 2 * 1024 * 1024;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

class CanonicalSermonBodyProjectionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CanonicalSermonBodyProjectionError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function fail(code, message, details = {}) {
  throw new CanonicalSermonBodyProjectionError(code, message, details);
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(raw, required, optional, field, code) {
  if (!isRecord(raw)) fail(code, `${field} must be an object.`, { field });
  const allowed = new Set([...required, ...optional]);
  const actual = Object.keys(raw);
  const missing = required.filter(key =>
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

function identifier(value, field, code) {
  if (
    typeof value !== 'string'
    || !ID_PATTERN.test(value)
    || ['__proto__', 'prototype', 'constructor'].includes(value)
  ) {
    fail(code, `${field} must be a canonical identifier.`, { field });
  }
  return value;
}

function nullableIdentifier(value, field, code) {
  return value === null ? null : identifier(value, field, code);
}

function revision(value, field, code) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    fail(code, `${field} must be a lowercase SHA-256.`, { field });
  }
  return value;
}

function boundedText(value, field, maximum, code, { allowEmpty = false } = {}) {
  if (
    typeof value !== 'string'
    || value.length > maximum
    || (!allowEmpty && value.length === 0)
  ) {
    fail(code, `${field} is outside its safe text limit.`, {
      field,
      maximum
    });
  }
  return value;
}

function integer(value, field, minimum, maximum, code) {
  if (
    !Number.isSafeInteger(value)
    || value < minimum
    || value > maximum
  ) {
    fail(code, `${field} is outside its safe numeric limit.`, {
      field,
      minimum,
      maximum
    });
  }
  return value;
}

function canonicalTimestamp(value, field, code) {
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
    fail('INVALID_PROJECTION_REQUEST', 'Projection proposal time is invalid.');
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

function sameList(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function canonicalProject(raw) {
  try {
    return normalizeServiceProject(raw);
  } catch (error) {
    fail('INVALID_PROJECT', 'The service project is invalid.', {
      causeCode: error?.code || null
    });
  }
}

function paragraphCandidates(bodyEntry) {
  const segments = sermonBodyParagraphCandidates(bodyEntry);
  if (
    segments.length < 1
    || segments.length > MAX_BODY_PROJECTION_PARAGRAPHS
  ) {
    fail(
      'BODY_ENTRY_PARAGRAPH_LIMIT',
      `A reviewed body entry must contain between one and ${MAX_BODY_PROJECTION_PARAGRAPHS} deterministic paragraphs.`,
      {
        bodyEntryId: bodyEntry.id,
        paragraphCount: segments.length,
        maximum: MAX_BODY_PROJECTION_PARAGRAPHS
      }
    );
  }
  return segments.map((segment, index) => {
    if (segment.text.length > MAX_BODY_PROJECTION_TEXT_CHARS) {
      fail(
        'BODY_PARAGRAPH_TOO_LARGE',
        `A canonical body paragraph may contain at most ${MAX_BODY_PROJECTION_TEXT_CHARS} characters.`,
        {
          bodyEntryId: bodyEntry.id,
          paragraph: index + 1,
          maximum: MAX_BODY_PROJECTION_TEXT_CHARS
        }
      );
    }
    return {
      ...segment,
      defaultAction: 'skip'
    };
  });
}

function parentBinding(project, anchorItemId) {
  const parentItemId = project._index.parentByItemId[anchorItemId];
  return {
    itemId: parentItemId,
    childIds: parentItemId === null
      ? [...project.rootItemIds]
      : [...project.items[parentItemId].childIds]
  };
}

function anchorBinding(project, anchor, linked) {
  return {
    itemId: anchor.id,
    groupKind: anchor.groupKind,
    resourceId: linked.resourceId,
    resourceOwnerId: linked.resourceOwnerId,
    parent: parentBinding(project, anchor.id),
    childIds: [...anchor.childIds]
  };
}

function existingTargets(project, anchor, linked) {
  if (anchor.childIds.length > MAX_BODY_PROJECTION_EXISTING_CHILDREN) {
    fail(
      'SERMON_TREE_TOO_LARGE',
      `A selected group may contain at most ${MAX_BODY_PROJECTION_EXISTING_CHILDREN} direct children for one body projection review.`,
      {
        childCount: anchor.childIds.length,
        maximum: MAX_BODY_PROJECTION_EXISTING_CHILDREN
      }
    );
  }
  const result = [];
  for (const [position, itemId] of anchor.childIds.entries()) {
    const item = project.items[itemId];
    if (!item || item.kind !== 'sermon') continue;
    let resolved;
    try {
      resolved = resolveSermonSourceLink(project, item);
    } catch (_error) {
      continue;
    }
    if (
      !resolved
      || resolved.resourceId !== linked.resourceId
      || resolved.resourceOwnerId !== linked.resourceOwnerId
      || resolved.resource.sha256 !== linked.resource.sha256
    ) {
      continue;
    }
    result.push({
      itemId,
      position,
      fingerprint: canonicalHash({
        item,
        resourceId: resolved.resourceId,
        resourceOwnerId: resolved.resourceOwnerId,
        sermonRevisionId: resolved.resource.sha256,
        sectionId: resolved.sectionId || null,
        sectionOwnerId: resolved.sectionOwnerId || null
      })
    });
  }
  return result;
}

function buildCanonicalSermonBodyProjectionProposal(options = {}) {
  exactKeys(options, [
    'project',
    'projectRevisionId',
    'anchorItemId',
    'sermonId',
    'sermonRevisionId',
    'channelMappings'
  ], ['now'], 'Canonical sermon body projection request', 'INVALID_PROJECTION_REQUEST');
  const project = canonicalProject(options.project);
  const projectRevisionId = revision(
    options.projectRevisionId,
    'Saved project revision',
    'INVALID_PROJECTION_REQUEST'
  );
  if (serviceProjectRevisionId(project) !== projectRevisionId) {
    fail(
      'PROJECT_REVISION_MISMATCH',
      'The service project does not match the exact saved revision selected for body projection.'
    );
  }
  const anchorItemId = identifier(
    options.anchorItemId,
    'Sermon group anchor',
    'INVALID_PROJECTION_REQUEST'
  );
  const sermonId = identifier(
    options.sermonId,
    'Sermon id',
    'INVALID_PROJECTION_REQUEST'
  );
  const sermonRevisionId = revision(
    options.sermonRevisionId,
    'Sermon revision',
    'INVALID_PROJECTION_REQUEST'
  );
  const { anchor, linked } = requireSermonCueReconciliationAnchor(
    project,
    anchorItemId,
    sermonId,
    sermonRevisionId
  );
  const sermon = linked.resource.document;
  if (sermon.schemaVersion !== 3 || !Array.isArray(sermon.body)) {
    fail(
      'CANONICAL_BODY_REQUIRED',
      'Native sermon body projection requires an exact canonical schema-v3 sermon.'
    );
  }
  if (
    !Array.isArray(options.channelMappings)
    || options.channelMappings.length !== project.channelIds.length
    || options.channelMappings.length > MAX_BODY_PROJECTION_CHANNELS
  ) {
    fail(
      'EXPLICIT_CHANNEL_MAPPING_REQUIRED',
      'Map or hide every project output explicitly before reviewing canonical sermon text.'
    );
  }
  const mappingsByChannel = new Map();
  for (const [index, raw] of options.channelMappings.entries()) {
    exactKeys(
      raw,
      ['channelId', 'mode'],
      ['bodyEntryId'],
      `Body projection channel mapping ${index + 1}`,
      'INVALID_CHANNEL_MAPPING'
    );
    const channelId = identifier(
      raw.channelId,
      `Body projection channel mapping ${index + 1} channel`,
      'INVALID_CHANNEL_MAPPING'
    );
    if (!project.channelIds.includes(channelId) || mappingsByChannel.has(channelId)) {
      fail(
        mappingsByChannel.has(channelId)
          ? 'DUPLICATE_CHANNEL_MAPPING'
          : 'UNKNOWN_CHANNEL',
        'Every project output must have one distinct explicit body mapping.',
        { channelId }
      );
    }
    if (!['body-entry', 'hidden'].includes(raw.mode)) {
      fail(
        'INVALID_CHANNEL_MAPPING',
        'A body projection output must select one canonical body entry or be hidden.',
        { channelId }
      );
    }
    const bodyEntryId = raw.bodyEntryId === undefined
      || raw.bodyEntryId === null
      ? null
      : identifier(
          raw.bodyEntryId,
          `Body projection channel ${channelId} body entry`,
          'INVALID_CHANNEL_MAPPING'
        );
    if (
      (raw.mode === 'hidden' && bodyEntryId !== null)
      || (raw.mode === 'body-entry' && bodyEntryId === null)
    ) {
      fail(
        'INVALID_CHANNEL_MAPPING',
        'Hidden outputs cannot select body text, and mapped outputs require one exact body entry.',
        { channelId }
      );
    }
    mappingsByChannel.set(channelId, { channelId, mode: raw.mode, bodyEntryId });
  }

  const selectedEntryIds = new Set();
  const bodyEntries = [];
  let candidateCount = 0;
  let totalTextBytes = 0;
  for (const channelId of project.channelIds) {
    const mapping = mappingsByChannel.get(channelId);
    if (!mapping) {
      fail(
        'EXPLICIT_CHANNEL_MAPPING_REQUIRED',
        'Map or hide every project output explicitly.',
        { channelId }
      );
    }
    if (mapping.mode === 'hidden' || selectedEntryIds.has(mapping.bodyEntryId)) {
      continue;
    }
    const entry = sermon.body.find(candidate => candidate.id === mapping.bodyEntryId);
    if (!entry) {
      fail(
        'UNKNOWN_BODY_ENTRY',
        'A mapped canonical body entry is not present in the exact sermon revision.',
        { channelId, bodyEntryId: mapping.bodyEntryId }
      );
    }
    const paragraphs = paragraphCandidates(entry);
    totalTextBytes += paragraphs.reduce((total, paragraph) =>
      total + Buffer.byteLength(paragraph.text, 'utf8'), 0);
    if (totalTextBytes > MAX_BODY_PROJECTION_TEXT_BYTES) {
      fail(
        'PROJECTION_TOO_LARGE',
        'Selected canonical body text exceeds the safe projection review limit.',
        { maximumBytes: MAX_BODY_PROJECTION_TEXT_BYTES }
      );
    }
    bodyEntries.push({
      id: entry.id,
      kind: entry.kind,
      language: entry.language,
      sourceId: entry.sourceId,
      sectionId: entry.sectionId,
      sha256: sermonBodyEntryRevisionId(entry),
      paragraphs
    });
    selectedEntryIds.add(entry.id);
  }
  const bodyEntriesById = new Map(bodyEntries.map(entry => [entry.id, entry]));
  const channelMappings = project.channelIds.map(channelId => {
    const mapping = mappingsByChannel.get(channelId);
    const channel = project.channels[channelId];
    if (mapping.mode === 'body-entry') {
      const entry = bodyEntriesById.get(mapping.bodyEntryId);
      if (!entry) {
        fail(
          'UNKNOWN_BODY_ENTRY',
          'A mapped canonical body entry is not present in the exact sermon revision.',
          { channelId, bodyEntryId: mapping.bodyEntryId }
        );
      }
      candidateCount += entry.paragraphs.length;
    }
    return {
      channelId,
      channelLabel: channel.label,
      channelLanguage: channel.language,
      mode: mapping.mode,
      bodyEntryId: mapping.bodyEntryId
    };
  });
  if (candidateCount < 1) {
    fail(
      'VISIBLE_BODY_ENTRY_REQUIRED',
      'At least one project output must select canonical sermon body text.'
    );
  }
  if (candidateCount > MAX_BODY_PROJECTION_CANDIDATES) {
    fail(
      'TOO_MANY_CANDIDATES',
      `One body projection review may contain at most ${MAX_BODY_PROJECTION_CANDIDATES} channel-bound paragraph candidates.`,
      { candidateCount, maximum: MAX_BODY_PROJECTION_CANDIDATES }
    );
  }

  const proposal = {
    schemaVersion: CANONICAL_SERMON_BODY_PROJECTION_SCHEMA_VERSION,
    kind: CANONICAL_SERMON_BODY_PROJECTION_KIND,
    createdAt: proposalTimestamp(options.now),
    project: {
      id: project.id,
      revisionId: projectRevisionId,
      revision: project.revision,
      updatedAt: project.updatedAt
    },
    anchor: anchorBinding(project, anchor, linked),
    sermon: {
      id: sermonId,
      revisionId: sermonRevisionId,
      schemaVersion: 3
    },
    channelMappings,
    bodyEntries,
    candidateCount,
    existingTargets: existingTargets(project, anchor, linked)
  };
  return deepFreeze({ ...proposal, id: canonicalHash(proposal) });
}

function normalizeIdList(raw, field, maximum, code) {
  if (!Array.isArray(raw) || raw.length > maximum) {
    fail(code, `${field} exceeds its safe list limit.`, { field, maximum });
  }
  const values = raw.map((value, index) =>
    identifier(value, `${field} ${index + 1}`, code));
  if (new Set(values).size !== values.length) {
    fail(code, `${field} contains duplicate identifiers.`, { field });
  }
  return values;
}

function normalizeCanonicalSermonBodyProjectionProposal(raw) {
  exactKeys(raw, [
    'schemaVersion',
    'kind',
    'createdAt',
    'project',
    'anchor',
    'sermon',
    'channelMappings',
    'bodyEntries',
    'candidateCount',
    'existingTargets',
    'id'
  ], [], 'Canonical sermon body projection proposal', 'INVALID_PROPOSAL');
  if (
    raw.schemaVersion !== CANONICAL_SERMON_BODY_PROJECTION_SCHEMA_VERSION
    || raw.kind !== CANONICAL_SERMON_BODY_PROJECTION_KIND
  ) {
    fail('INVALID_PROPOSAL', 'The canonical sermon body projection schema is unsupported.');
  }
  exactKeys(
    raw.project,
    ['id', 'revisionId', 'revision', 'updatedAt'],
    [],
    'Projection project binding',
    'INVALID_PROPOSAL'
  );
  exactKeys(
    raw.anchor,
    [
      'itemId',
      'groupKind',
      'resourceId',
      'resourceOwnerId',
      'parent',
      'childIds'
    ],
    [],
    'Projection anchor binding',
    'INVALID_PROPOSAL'
  );
  exactKeys(
    raw.anchor.parent,
    ['itemId', 'childIds'],
    [],
    'Projection anchor parent binding',
    'INVALID_PROPOSAL'
  );
  exactKeys(
    raw.sermon,
    ['id', 'revisionId', 'schemaVersion'],
    [],
    'Projection sermon binding',
    'INVALID_PROPOSAL'
  );
  const project = {
    id: identifier(raw.project.id, 'Projection project id', 'INVALID_PROPOSAL'),
    revisionId: revision(
      raw.project.revisionId,
      'Projection project revision',
      'INVALID_PROPOSAL'
    ),
    revision: integer(
      raw.project.revision,
      'Projection project revision number',
      0,
      Number.MAX_SAFE_INTEGER,
      'INVALID_PROPOSAL'
    ),
    updatedAt: canonicalTimestamp(
      raw.project.updatedAt,
      'Projection project updatedAt',
      'INVALID_PROPOSAL'
    )
  };
  const anchor = {
    itemId: identifier(raw.anchor.itemId, 'Projection anchor id', 'INVALID_PROPOSAL'),
    groupKind: identifier(
      raw.anchor.groupKind,
      'Projection anchor group kind',
      'INVALID_PROPOSAL'
    ),
    resourceId: boundedText(
      raw.anchor.resourceId,
      'Projection anchor resource id',
      80,
      'INVALID_PROPOSAL'
    ),
    resourceOwnerId: identifier(
      raw.anchor.resourceOwnerId,
      'Projection anchor resource owner',
      'INVALID_PROPOSAL'
    ),
    parent: {
      itemId: nullableIdentifier(
        raw.anchor.parent.itemId,
        'Projection anchor parent id',
        'INVALID_PROPOSAL'
      ),
      childIds: normalizeIdList(
        raw.anchor.parent.childIds,
        'Projection anchor parent child ids',
        MAX_BODY_PROJECTION_EXISTING_CHILDREN,
        'INVALID_PROPOSAL'
      )
    },
    childIds: normalizeIdList(
      raw.anchor.childIds,
      'Projection anchor child ids',
      MAX_BODY_PROJECTION_EXISTING_CHILDREN,
      'INVALID_PROPOSAL'
    )
  };
  const sermon = {
    id: identifier(raw.sermon.id, 'Projection sermon id', 'INVALID_PROPOSAL'),
    revisionId: revision(
      raw.sermon.revisionId,
      'Projection sermon revision',
      'INVALID_PROPOSAL'
    ),
    schemaVersion: raw.sermon.schemaVersion
  };
  if (sermon.schemaVersion !== 3) {
    fail('INVALID_PROPOSAL', 'Projection sermon binding must use canonical schema v3.');
  }

  if (
    !Array.isArray(raw.bodyEntries)
    || raw.bodyEntries.length < 1
    || raw.bodyEntries.length > MAX_BODY_PROJECTION_CHANNELS
  ) {
    fail('INVALID_PROPOSAL', 'Projection body-entry pools are outside the safe limit.');
  }
  const bodyEntryIds = new Set();
  let totalTextBytes = 0;
  const bodyEntries = raw.bodyEntries.map((rawEntry, entryIndex) => {
    const field = `Projection body entry ${entryIndex + 1}`;
    exactKeys(rawEntry, [
      'id',
      'kind',
      'language',
      'sourceId',
      'sectionId',
      'sha256',
      'paragraphs'
    ], [], field, 'INVALID_PROPOSAL');
    const entryId = identifier(rawEntry.id, `${field} id`, 'INVALID_PROPOSAL');
    if (bodyEntryIds.has(entryId)) {
      fail('INVALID_PROPOSAL', 'Projection repeats a canonical body entry.');
    }
    bodyEntryIds.add(entryId);
    if (
      !Array.isArray(rawEntry.paragraphs)
      || rawEntry.paragraphs.length < 1
      || rawEntry.paragraphs.length > MAX_BODY_PROJECTION_PARAGRAPHS
    ) {
      fail('INVALID_PROPOSAL', `${field} paragraph pool is outside the safe limit.`);
    }
    let previousEnd = 0;
    const paragraphs = rawEntry.paragraphs.map((rawParagraph, index) => {
      const paragraphField = `${field} paragraph ${index + 1}`;
      exactKeys(rawParagraph, [
        'id',
        'ordinal',
        'startOffset',
        'endOffset',
        'text',
        'textSha256',
        'defaultAction'
      ], [], paragraphField, 'INVALID_PROPOSAL');
      const paragraphId = identifier(
        rawParagraph.id,
        `${paragraphField} id`,
        'INVALID_PROPOSAL'
      );
      const ordinal = integer(
        rawParagraph.ordinal,
        `${paragraphField} ordinal`,
        1,
        MAX_BODY_PROJECTION_PARAGRAPHS,
        'INVALID_PROPOSAL'
      );
      const startOffset = integer(
        rawParagraph.startOffset,
        `${paragraphField} startOffset`,
        0,
        1024 * 1024,
        'INVALID_PROPOSAL'
      );
      const endOffset = integer(
        rawParagraph.endOffset,
        `${paragraphField} endOffset`,
        startOffset + 1,
        1024 * 1024,
        'INVALID_PROPOSAL'
      );
      const text = boundedText(
        rawParagraph.text,
        `${paragraphField} text`,
        MAX_BODY_PROJECTION_TEXT_CHARS,
        'INVALID_PROPOSAL'
      );
      totalTextBytes += Buffer.byteLength(text, 'utf8');
      if (
        paragraphId !== `paragraph-${String(index + 1).padStart(3, '0')}`
        || ordinal !== index + 1
        || startOffset < previousEnd
        || sha256(text) !== rawParagraph.textSha256
        || rawParagraph.defaultAction !== 'skip'
      ) {
        fail('INVALID_PROPOSAL', `${paragraphField} is not deterministic exact text.`);
      }
      previousEnd = endOffset;
      return {
        id: paragraphId,
        ordinal,
        startOffset,
        endOffset,
        text,
        textSha256: rawParagraph.textSha256,
        defaultAction: 'skip'
      };
    });
    return {
      id: entryId,
      kind: identifier(rawEntry.kind, `${field} kind`, 'INVALID_PROPOSAL'),
      language: boundedText(
        rawEntry.language,
        `${field} language`,
        35,
        'INVALID_PROPOSAL'
      ),
      sourceId: nullableIdentifier(
        rawEntry.sourceId,
        `${field} sourceId`,
        'INVALID_PROPOSAL'
      ),
      sectionId: nullableIdentifier(
        rawEntry.sectionId,
        `${field} sectionId`,
        'INVALID_PROPOSAL'
      ),
      sha256: revision(rawEntry.sha256, `${field} revision`, 'INVALID_PROPOSAL'),
      paragraphs
    };
  });
  if (totalTextBytes > MAX_BODY_PROJECTION_TEXT_BYTES) {
    fail('INVALID_PROPOSAL', 'Projection body text exceeds its safe aggregate limit.');
  }
  const entriesById = new Map(bodyEntries.map(entry => [entry.id, entry]));

  if (
    !Array.isArray(raw.channelMappings)
    || raw.channelMappings.length < 1
    || raw.channelMappings.length > MAX_BODY_PROJECTION_CHANNELS
  ) {
    fail('INVALID_PROPOSAL', 'Projection output mappings are outside the safe limit.');
  }
  const channelIds = new Set();
  let candidateCount = 0;
  const channelMappings = raw.channelMappings.map((rawMapping, index) => {
    const field = `Projection channel mapping ${index + 1}`;
    exactKeys(rawMapping, [
      'channelId',
      'channelLabel',
      'channelLanguage',
      'mode',
      'bodyEntryId'
    ], [], field, 'INVALID_PROPOSAL');
    const channelId = identifier(
      rawMapping.channelId,
      `${field} channel`,
      'INVALID_PROPOSAL'
    );
    if (channelIds.has(channelId)) {
      fail('INVALID_PROPOSAL', 'Projection repeats an output mapping.');
    }
    channelIds.add(channelId);
    if (!['body-entry', 'hidden'].includes(rawMapping.mode)) {
      fail('INVALID_PROPOSAL', `${field} mode is unsupported.`);
    }
    const bodyEntryId = nullableIdentifier(
      rawMapping.bodyEntryId,
      `${field} body entry`,
      'INVALID_PROPOSAL'
    );
    if (
      (rawMapping.mode === 'hidden' && bodyEntryId !== null)
      || (rawMapping.mode === 'body-entry' && !entriesById.has(bodyEntryId))
    ) {
      fail('INVALID_PROPOSAL', `${field} does not resolve explicitly.`);
    }
    if (bodyEntryId) candidateCount += entriesById.get(bodyEntryId).paragraphs.length;
    return {
      channelId,
      channelLabel: boundedText(
        rawMapping.channelLabel,
        `${field} label`,
        120,
        'INVALID_PROPOSAL'
      ),
      channelLanguage: boundedText(
        rawMapping.channelLanguage,
        `${field} language`,
        35,
        'INVALID_PROPOSAL'
      ),
      mode: rawMapping.mode,
      bodyEntryId
    };
  });
  if (
    candidateCount !== raw.candidateCount
    || candidateCount < 1
    || candidateCount > MAX_BODY_PROJECTION_CANDIDATES
  ) {
    fail('INVALID_PROPOSAL', 'Projection candidate count is inconsistent.');
  }
  const referencedEntries = new Set(
    channelMappings.map(mapping => mapping.bodyEntryId).filter(Boolean)
  );
  if (
    referencedEntries.size !== bodyEntries.length
    || bodyEntries.some(entry => !referencedEntries.has(entry.id))
  ) {
    fail('INVALID_PROPOSAL', 'Projection contains an unreferenced body-entry pool.');
  }

  if (
    !Array.isArray(raw.existingTargets)
    || raw.existingTargets.length > MAX_BODY_PROJECTION_EXISTING_CHILDREN
  ) {
    fail('INVALID_PROPOSAL', 'Projection existing targets exceed the safe limit.');
  }
  const targetIds = new Set();
  let previousPosition = -1;
  const existingTargets = raw.existingTargets.map((rawTarget, index) => {
    const field = `Projection existing target ${index + 1}`;
    exactKeys(
      rawTarget,
      ['itemId', 'position', 'fingerprint'],
      [],
      field,
      'INVALID_PROPOSAL'
    );
    const itemId = identifier(rawTarget.itemId, `${field} id`, 'INVALID_PROPOSAL');
    const position = integer(
      rawTarget.position,
      `${field} position`,
      0,
      Math.max(0, anchor.childIds.length - 1),
      'INVALID_PROPOSAL'
    );
    if (
      targetIds.has(itemId)
      || position <= previousPosition
      || anchor.childIds[position] !== itemId
    ) {
      fail('INVALID_PROPOSAL', 'Projection existing targets do not match anchor order.');
    }
    targetIds.add(itemId);
    previousPosition = position;
    return {
      itemId,
      position,
      fingerprint: revision(
        rawTarget.fingerprint,
        `${field} fingerprint`,
        'INVALID_PROPOSAL'
      )
    };
  });

  const normalized = {
    schemaVersion: CANONICAL_SERMON_BODY_PROJECTION_SCHEMA_VERSION,
    kind: CANONICAL_SERMON_BODY_PROJECTION_KIND,
    createdAt: canonicalTimestamp(
      raw.createdAt,
      'Projection createdAt',
      'INVALID_PROPOSAL'
    ),
    project,
    anchor,
    sermon,
    channelMappings,
    bodyEntries,
    candidateCount,
    existingTargets
  };
  const id = revision(raw.id, 'Projection proposal id', 'INVALID_PROPOSAL');
  if (canonicalHash(normalized) !== id) {
    fail('INVALID_PROPOSAL', 'The canonical body projection changed after review.');
  }
  return deepFreeze({ ...normalized, id });
}

function validateProposalAgainstProject(project, proposal) {
  if (
    project.id !== proposal.project.id
    || serviceProjectRevisionId(project) !== proposal.project.revisionId
    || project.revision !== proposal.project.revision
    || project.updatedAt !== proposal.project.updatedAt
  ) {
    fail(
      'PROJECT_REVISION_MISMATCH',
      'The service project changed after canonical body review.'
    );
  }
  const { anchor, linked } = requireSermonCueReconciliationAnchor(
    project,
    proposal.anchor.itemId,
    proposal.sermon.id,
    proposal.sermon.revisionId
  );
  if (
    canonicalJson(anchorBinding(project, anchor, linked))
      !== canonicalJson(proposal.anchor)
  ) {
    fail(
      'PROPOSAL_BINDING_MISMATCH',
      'The selected sermon group, parent, or exact child order changed.'
    );
  }
  const currentTargets = existingTargets(project, anchor, linked);
  if (canonicalJson(currentTargets) !== canonicalJson(proposal.existingTargets)) {
    fail(
      'PROPOSAL_BINDING_MISMATCH',
      'Eligible existing sermon cues changed after review.'
    );
  }
  if (
    !sameList(
      proposal.channelMappings.map(mapping => mapping.channelId),
      project.channelIds
    )
    || proposal.channelMappings.some(mapping => {
      const channel = project.channels[mapping.channelId];
      return !channel
        || channel.label !== mapping.channelLabel
        || channel.language !== mapping.channelLanguage;
    })
  ) {
    fail(
      'PROPOSAL_BINDING_MISMATCH',
      'Project outputs changed after canonical body review.'
    );
  }
  const sermon = linked.resource.document;
  if (sermon.schemaVersion !== 3) {
    fail('PROPOSAL_BINDING_MISMATCH', 'The exact sermon no longer has canonical body text.');
  }
  for (const entryPool of proposal.bodyEntries) {
    const entry = sermon.body.find(candidate => candidate.id === entryPool.id);
    if (
      !entry
      || entry.kind !== entryPool.kind
      || entry.language !== entryPool.language
      || entry.sourceId !== entryPool.sourceId
      || entry.sectionId !== entryPool.sectionId
      || sermonBodyEntryRevisionId(entry) !== entryPool.sha256
    ) {
      fail(
        'PROPOSAL_BINDING_MISMATCH',
        'A canonical body entry changed after review.',
        { bodyEntryId: entryPool.id }
      );
    }
    for (const paragraph of entryPool.paragraphs) {
      if (
        paragraph.endOffset > entry.text.length
        || entry.text.slice(paragraph.startOffset, paragraph.endOffset)
          !== paragraph.text
      ) {
        fail(
          'PROPOSAL_BINDING_MISMATCH',
          'A canonical body paragraph changed after review.',
          { bodyEntryId: entryPool.id, paragraphId: paragraph.id }
        );
      }
    }
  }
  return { anchor, linked };
}

function normalizeDecisions(raw, proposal) {
  exactKeys(
    raw,
    ['rows', 'skippedParagraphIdsByChannel'],
    [],
    'Canonical body projection decisions',
    'INVALID_DECISIONS'
  );
  if (!Array.isArray(raw.rows) || raw.rows.length > MAX_BODY_PROJECTION_ROWS) {
    fail(
      'INVALID_DECISIONS',
      `Canonical body projection may create or update at most ${MAX_BODY_PROJECTION_ROWS} rows.`
    );
  }
  if (!isRecord(raw.skippedParagraphIdsByChannel)) {
    fail(
      'MISSING_PARAGRAPH_DECISION',
      'Explicit skipped paragraph lists are required for every output.'
    );
  }
  const channelIds = proposal.channelMappings.map(mapping => mapping.channelId);
  if (
    Object.keys(raw.skippedParagraphIdsByChannel).length !== channelIds.length
    || Object.keys(raw.skippedParagraphIdsByChannel).some(channelId =>
      !channelIds.includes(channelId))
  ) {
    fail(
      'MISSING_PARAGRAPH_DECISION',
      'Explicit skipped paragraph lists must cover every project output.'
    );
  }
  const entryById = new Map(proposal.bodyEntries.map(entry => [entry.id, entry]));
  const mappingByChannel = new Map(
    proposal.channelMappings.map(mapping => [mapping.channelId, mapping])
  );
  const paragraphByChannel = new Map();
  const accountedByChannel = new Map();
  for (const channelId of channelIds) {
    const mapping = mappingByChannel.get(channelId);
    const paragraphs = mapping.mode === 'hidden'
      ? []
      : entryById.get(mapping.bodyEntryId).paragraphs;
    paragraphByChannel.set(
      channelId,
      new Map(paragraphs.map(paragraph => [paragraph.id, paragraph]))
    );
    accountedByChannel.set(channelId, new Set());
  }
  const existingTargetIds = new Set(
    proposal.existingTargets.map(target => target.itemId)
  );
  const usedTargetIds = new Set();
  const seenRowIds = new Set();
  let totalCondensedTextBytes = 0;
  const rows = raw.rows.map((rawRow, index) => {
    const field = `Canonical body projection row ${index + 1}`;
    const hasLegacyParagraphSelections = isRecord(rawRow)
      && Object.prototype.hasOwnProperty.call(
        rawRow,
        'paragraphIdsByChannel'
      );
    const hasTreatments = isRecord(rawRow)
      && Object.prototype.hasOwnProperty.call(rawRow, 'treatmentsByChannel');
    if (hasLegacyParagraphSelections === hasTreatments) {
      fail(
        'INVALID_DECISIONS',
        `${field} must use exactly one supported output decision shape.`,
        { field }
      );
    }
    const rowChannelField = hasLegacyParagraphSelections
      ? 'paragraphIdsByChannel'
      : 'treatmentsByChannel';
    exactKeys(rawRow, [
      'rowId',
      'action',
      rowChannelField
    ], ['targetItemId'], field, 'INVALID_DECISIONS');
    const rowId = identifier(rawRow.rowId, `${field} id`, 'INVALID_DECISIONS');
    if (seenRowIds.has(rowId)) {
      fail('DUPLICATE_ROW_DECISION', 'A projection row id is repeated.', { rowId });
    }
    seenRowIds.add(rowId);
    if (!['insert', 'update'].includes(rawRow.action)) {
      fail(
        'INVALID_DECISIONS',
        'Authored projection rows must explicitly insert or update; skipped paragraphs belong in the explicit skipped lists.',
        { rowId }
      );
    }
    const targetItemId = rawRow.targetItemId === undefined
      || rawRow.targetItemId === null
      ? null
      : identifier(
          rawRow.targetItemId,
          `${field} target item`,
          'INVALID_DECISIONS'
        );
    if (rawRow.action === 'update') {
      if (!targetItemId || !existingTargetIds.has(targetItemId)) {
        fail(
          'UNKNOWN_EXISTING_TARGET',
          'Every Update row must select one reviewed eligible sermon cue.',
          { rowId, targetItemId }
        );
      }
      if (usedTargetIds.has(targetItemId)) {
        fail(
          'EXISTING_TARGET_REUSED',
          'One existing sermon cue cannot be updated by multiple rows.',
          { targetItemId }
        );
      }
      usedTargetIds.add(targetItemId);
    } else if (targetItemId !== null) {
      fail(
        'INVALID_DECISIONS',
        'Only an Update row may select an existing sermon cue.',
        { rowId }
      );
    }
    const rawChannelDecisions = rawRow[rowChannelField];
    if (
      !isRecord(rawChannelDecisions)
      || Object.keys(rawChannelDecisions).length !== channelIds.length
      || Object.keys(rawChannelDecisions).some(channelId =>
        !channelIds.includes(channelId))
    ) {
      fail(
        'MISSING_PARAGRAPH_DECISION',
        'Every authored row must explicitly select or hide every output.',
        { rowId }
      );
    }
    const treatmentsByChannel = {};
    let selectedCount = 0;
    for (const channelId of channelIds) {
      const mapping = mappingByChannel.get(channelId);
      const rawChannelDecision = rawChannelDecisions[channelId];
      let treatment;
      if (hasLegacyParagraphSelections) {
        treatment = rawChannelDecision === null
          ? { mode: 'hidden' }
          : { mode: 'exact', paragraphId: rawChannelDecision };
      } else {
        if (!isRecord(rawChannelDecision)) {
          fail(
            'INVALID_DECISIONS',
            `${field} ${channelId} treatment must be explicit.`,
            { rowId, channelId }
          );
        }
        const mode = rawChannelDecision.mode;
        if (mode === 'hidden') {
          exactKeys(
            rawChannelDecision,
            ['mode'],
            [],
            `${field} ${channelId} treatment`,
            'INVALID_DECISIONS'
          );
          treatment = { mode: 'hidden' };
        } else if (mode === 'exact') {
          exactKeys(
            rawChannelDecision,
            ['mode', 'paragraphId'],
            [],
            `${field} ${channelId} treatment`,
            'INVALID_DECISIONS'
          );
          treatment = {
            mode,
            paragraphId: rawChannelDecision.paragraphId
          };
        } else if (mode === 'condensed') {
          exactKeys(
            rawChannelDecision,
            ['mode', 'paragraphId', 'text'],
            [],
            `${field} ${channelId} treatment`,
            'INVALID_DECISIONS'
          );
          const condensedText = boundedText(
            rawChannelDecision.text,
            `${field} ${channelId} condensed text`,
            MAX_BODY_PROJECTION_TEXT_CHARS,
            'INVALID_DECISIONS'
          );
          if (condensedText.trim().length < 1) {
            fail(
              'INVALID_DECISIONS',
              `${field} ${channelId} condensed text must not be blank.`,
              { rowId, channelId }
            );
          }
          totalCondensedTextBytes += Buffer.byteLength(condensedText, 'utf8');
          if (totalCondensedTextBytes > MAX_BODY_PROJECTION_TEXT_BYTES) {
            fail(
              'PROJECTION_TOO_LARGE',
              'Operator-authored condensed text exceeds the safe projection limit.',
              { maximumBytes: MAX_BODY_PROJECTION_TEXT_BYTES }
            );
          }
          treatment = {
            mode,
            paragraphId: rawChannelDecision.paragraphId,
            text: condensedText
          };
        } else {
          fail(
            'INVALID_DECISIONS',
            `${field} ${channelId} treatment must be exact, condensed, or hidden.`,
            { rowId, channelId, mode }
          );
        }
      }
      if (treatment.mode === 'hidden') {
        treatmentsByChannel[channelId] = treatment;
        continue;
      }
      if (mapping.mode === 'hidden') {
        fail(
          'HIDDEN_CHANNEL_SELECTED',
          'A hidden output cannot select canonical body text.',
          { rowId, channelId }
        );
      }
      const paragraphId = identifier(
        treatment.paragraphId,
        `${field} ${channelId} paragraph`,
        'INVALID_DECISIONS'
      );
      if (!paragraphByChannel.get(channelId).has(paragraphId)) {
        fail(
          'UNKNOWN_PARAGRAPH',
          'A row selected a paragraph outside that output’s explicit body entry.',
          { rowId, channelId, paragraphId }
        );
      }
      if (accountedByChannel.get(channelId).has(paragraphId)) {
        fail(
          'PARAGRAPH_REUSED',
          'One canonical paragraph cannot be projected or skipped more than once per output.',
          { rowId, channelId, paragraphId }
        );
      }
      accountedByChannel.get(channelId).add(paragraphId);
      treatmentsByChannel[channelId] = {
        ...treatment,
        paragraphId
      };
      selectedCount += 1;
    }
    if (selectedCount < 1) {
      fail(
        'EMPTY_PROJECTION_ROW',
        'Every inserted or updated row must select canonical text for at least one output.',
        { rowId }
      );
    }
    return {
      rowId,
      action: rawRow.action,
      targetItemId,
      treatmentsByChannel
    };
  });

  const skippedParagraphIdsByChannel = {};
  for (const channelId of channelIds) {
    const mapping = mappingByChannel.get(channelId);
    const skipped = normalizeIdList(
      raw.skippedParagraphIdsByChannel[channelId],
      `Skipped canonical paragraphs for ${channelId}`,
      MAX_BODY_PROJECTION_PARAGRAPHS,
      'INVALID_DECISIONS'
    );
    if (mapping.mode === 'hidden' && skipped.length > 0) {
      fail(
        'HIDDEN_CHANNEL_SELECTED',
        'A hidden output has no canonical paragraphs to skip.',
        { channelId }
      );
    }
    for (const paragraphId of skipped) {
      if (!paragraphByChannel.get(channelId).has(paragraphId)) {
        fail(
          'UNKNOWN_PARAGRAPH',
          'A skipped paragraph is outside that output’s explicit body entry.',
          { channelId, paragraphId }
        );
      }
      if (accountedByChannel.get(channelId).has(paragraphId)) {
        fail(
          'PARAGRAPH_REUSED',
          'One canonical paragraph cannot be projected or skipped more than once per output.',
          { channelId, paragraphId }
        );
      }
      accountedByChannel.get(channelId).add(paragraphId);
    }
    const expectedCount = paragraphByChannel.get(channelId).size;
    if (accountedByChannel.get(channelId).size !== expectedCount) {
      fail(
        'MISSING_PARAGRAPH_DECISION',
        'Every paragraph in every explicitly mapped body entry must be used once or explicitly skipped.',
        {
          channelId,
          expectedCount,
          accountedCount: accountedByChannel.get(channelId).size
        }
      );
    }
    skippedParagraphIdsByChannel[channelId] = skipped;
  }
  return { rows, skippedParagraphIdsByChannel };
}

function normalizePlacementIndex(value, childCount, rowCount) {
  if (rowCount === 0) {
    if (value !== undefined && value !== null) {
      fail('INVALID_PLACEMENT', 'An all-skipped review cannot choose a placement.');
    }
    return null;
  }
  if (value === undefined && childCount === 0) return 0;
  return integer(
    value,
    'Canonical body projection placement',
    0,
    childCount,
    childCount > 0 ? 'PLACEMENT_REQUIRED' : 'INVALID_PLACEMENT'
  );
}

function titleForText(text) {
  const firstLine = text.split('\n').map(line => line.trim()).find(Boolean)
    || 'Sermon note';
  let title = firstLine.slice(0, 200);
  if (
    title.length > 0
    && title.charCodeAt(title.length - 1) >= 0xD800
    && title.charCodeAt(title.length - 1) <= 0xDBFF
  ) {
    title = title.slice(0, -1);
  }
  return title || 'Sermon note';
}

function itemPlans(project, proposal, decisions, idFactory) {
  const entryById = new Map(proposal.bodyEntries.map(entry => [entry.id, entry]));
  const seenGeneratedIds = new Set();
  return decisions.rows.map((decision, index) => {
    let itemId = decision.targetItemId;
    if (decision.action === 'insert') {
      let generated;
      try {
        generated = idFactory({
          proposalId: proposal.id,
          rowId: decision.rowId,
          ordinal: index + 1
        });
      } catch (error) {
        fail('INVALID_ITEM_ID', 'The sermon item identity generator failed.', {
          cause: error?.message || null
        });
      }
      itemId = identifier(
        generated,
        `Generated sermon item for ${decision.rowId}`,
        'INVALID_ITEM_ID'
      );
      if (seenGeneratedIds.has(itemId) || project.items[itemId]) {
        fail(
          'DUPLICATE_ITEM_ID',
          'A generated sermon item id is duplicated or already exists.',
          { itemId }
        );
      }
      seenGeneratedIds.add(itemId);
    }
    const existing = decision.action === 'update'
      ? project.items[itemId]
      : null;
    if (decision.action === 'update' && existing?.kind !== 'sermon') {
      fail('UNKNOWN_EXISTING_TARGET', 'A reviewed sermon target no longer exists.');
    }
    const textByChannel = {};
    const sourceChannels = {};
    const usesCondensedTreatment = Object.values(
      decision.treatmentsByChannel
    ).some(treatment => treatment.mode === 'condensed');
    for (const mapping of proposal.channelMappings) {
      const treatment = decision.treatmentsByChannel[mapping.channelId];
      if (treatment.mode === 'hidden') continue;
      const entry = entryById.get(mapping.bodyEntryId);
      const paragraph = entry.paragraphs.find(candidate =>
        candidate.id === treatment.paragraphId);
      const projectedText = treatment.mode === 'condensed'
        ? treatment.text
        : paragraph.text;
      textByChannel[mapping.channelId] = projectedText;
      sourceChannels[mapping.channelId] = usesCondensedTreatment
        ? {
            mode: treatment.mode,
            bodyEntryId: entry.id,
            bodyEntrySha256: entry.sha256,
            paragraphId: paragraph.id,
            startOffset: paragraph.startOffset,
            endOffset: paragraph.endOffset,
            sourceTextSha256: paragraph.textSha256,
            projectedTextSha256: sha256(projectedText)
          }
        : {
            bodyEntryId: entry.id,
            bodyEntrySha256: entry.sha256,
            paragraphId: paragraph.id,
            startOffset: paragraph.startOffset,
            endOffset: paragraph.endOffset,
            textSha256: paragraph.textSha256
          };
    }
    const firstText = Object.values(textByChannel)[0];
    const rawItem = {
      ...(existing ? deepClone(existing) : {}),
      id: itemId,
      kind: 'sermon',
      title: existing ? existing.title : titleForText(firstText),
      textByChannel,
      ...(existing?.sermonResourceId
        ? { sermonResourceId: existing.sermonResourceId }
        : {}),
      ...(existing?.sermonSectionId
        ? { sermonSectionId: existing.sermonSectionId }
        : {}),
      sourceBodyProjection: {
        schemaVersion: usesCondensedTreatment
          ? SOURCE_BODY_PROJECTION_SCHEMA_VERSION_V2
          : SOURCE_BODY_PROJECTION_SCHEMA_VERSION,
        kind: SOURCE_BODY_PROJECTION_KIND,
        proposalId: proposal.id,
        rowId: decision.rowId,
        anchorItemId: proposal.anchor.itemId,
        sermonId: proposal.sermon.id,
        sermonRevisionId: proposal.sermon.revisionId,
        channels: sourceChannels
      },
      presetId: existing?.presetId || 'sermon-notes',
      operatorNotes: existing?.operatorNotes || '',
      createdAt: existing?.createdAt || proposal.createdAt,
      updatedAt: proposal.createdAt
    };
    delete rawItem.titlesByChannel;
    delete rawItem.spansByChannel;
    return {
      itemId,
      mode: decision.action,
      decision,
      rawItem
    };
  });
}

function mutateProject(project, proposal, plans, placementIndex) {
  const raw = JSON.parse(serializeServiceProject(project));
  const anchor = raw.items[proposal.anchor.itemId];
  if (!anchor || !sameList(anchor.childIds, proposal.anchor.childIds)) {
    fail(
      'PROJECT_REVISION_MISMATCH',
      'The selected sermon group order changed after review.'
    );
  }
  const updatedIds = new Set(
    plans.filter(plan => plan.mode === 'update').map(plan => plan.itemId)
  );
  for (const plan of plans) raw.items[plan.itemId] = deepClone(plan.rawItem);
  const remaining = proposal.anchor.childIds.filter(itemId =>
    !updatedIds.has(itemId));
  const adjustedPlacement = proposal.anchor.childIds
    .slice(0, placementIndex)
    .filter(itemId => !updatedIds.has(itemId))
    .length;
  remaining.splice(adjustedPlacement, 0, ...plans.map(plan => plan.itemId));
  anchor.childIds = remaining;
  if (raw.planning) {
    raw.planning.status = 'planning';
    delete raw.planning.readinessWaivers;
  }
  try {
    return normalizeServiceProject(raw);
  } catch (error) {
    fail(
      'PROJECT_MUTATION_FAILED',
      'Reviewed canonical body rows could not form one valid native service project.',
      { causeCode: error?.code || null }
    );
  }
}

function applyCanonicalSermonBodyProjection(options = {}) {
  exactKeys(options, [
    'project',
    'proposal',
    'decisions',
    'confirmed',
    'idFactory'
  ], ['placementIndex'], 'Canonical body projection apply request', 'INVALID_PROJECTION_REQUEST');
  if (options.confirmed !== true) {
    fail(
      'CONFIRMATION_REQUIRED',
      'Confirm the complete canonical body paragraph accounting before applying.'
    );
  }
  if (typeof options.idFactory !== 'function') {
    fail('INVALID_ITEM_ID', 'Canonical body projection requires an item identity factory.');
  }
  const proposal = normalizeCanonicalSermonBodyProjectionProposal(options.proposal);
  const project = canonicalProject(options.project);
  validateProposalAgainstProject(project, proposal);
  const decisions = normalizeDecisions(options.decisions, proposal);
  const placementIndex = normalizePlacementIndex(
    options.placementIndex,
    proposal.anchor.childIds.length,
    decisions.rows.length
  );
  if (decisions.rows.length === 0) {
    return deepFreeze({
      changed: false,
      unchanged: true,
      project,
      insertedItemIds: [],
      updatedItemIds: [],
      skippedParagraphIdsByChannel: decisions.skippedParagraphIdsByChannel
    });
  }
  const plans = itemPlans(project, proposal, decisions, options.idFactory);
  const next = mutateProject(project, proposal, plans, placementIndex);
  return deepFreeze({
    changed: true,
    unchanged: false,
    project: next,
    insertedItemIds: plans
      .filter(plan => plan.mode === 'insert')
      .map(plan => plan.itemId),
    updatedItemIds: plans
      .filter(plan => plan.mode === 'update')
      .map(plan => plan.itemId),
    skippedParagraphIdsByChannel: decisions.skippedParagraphIdsByChannel
  });
}

module.exports = {
  CANONICAL_SERMON_BODY_PROJECTION_KIND,
  CANONICAL_SERMON_BODY_PROJECTION_SCHEMA_VERSION,
  MAX_BODY_PROJECTION_CANDIDATES,
  MAX_BODY_PROJECTION_CHANNELS,
  MAX_BODY_PROJECTION_PARAGRAPHS,
  MAX_BODY_PROJECTION_ROWS,
  MAX_BODY_PROJECTION_TEXT_BYTES,
  MAX_BODY_PROJECTION_TEXT_CHARS,
  CanonicalSermonBodyProjectionError,
  applyCanonicalSermonBodyProjection,
  buildCanonicalSermonBodyProjectionProposal,
  normalizeCanonicalSermonBodyProjectionProposal
};
