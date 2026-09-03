'use strict';

const crypto = require('crypto');

const {
  MAX_SERMON_BODY_BYTES,
  MAX_SERMON_BODY_ENTRY_BYTES,
  SERMON_SCHEMA_VERSION,
  normalizeSermonDocument,
  sermonDocumentSha256,
  upgradeSermonDocument
} = require('./SermonDocument');

const NATIVE_SERMON_MATERIAL_PROPOSAL_SCHEMA_VERSION = 1;
const NATIVE_SERMON_MATERIAL_PROPOSAL_KIND =
  'syncshow-native-sermon-material-proposal';
const NATIVE_SERMON_MATERIAL_COMMIT_SCHEMA_VERSION = 1;
const NATIVE_SERMON_MATERIAL_COMMIT_KIND =
  'syncshow-native-sermon-material-commit';
const NATIVE_SERMON_MATERIAL_APPLICATION_SCHEMA_VERSION = 1;
const NATIVE_SERMON_MATERIAL_APPLICATION_KIND =
  'syncshow-native-sermon-material-application';
const NATIVE_SERMON_MATERIAL_REVIEW_STATEMENT_ID =
  'complete-pasted-sermon-material-v1';
const NATIVE_SERMON_MATERIAL_REVIEW_STATEMENT =
  'I reviewed every complete pasted text block, its role, and its language.';
const NATIVE_SERMON_MATERIAL_REASON = 'add-native-sermon-material';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REVISION_PATTERN = /^[a-f0-9]{64}$/;
const RESOURCE_ID_PATTERN = /^sha256:[a-f0-9]{64}$/;
const LANGUAGE_PATTERN = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/;
const DISALLOWED_BODY_CONTROLS =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;
const DISALLOWED_SINGLE_LINE_CONTROLS = /[\u0000-\u001f\u007f-\u009f]/u;
const MATERIAL_DEFINITIONS = Object.freeze([
  Object.freeze({ inputKey: 'manuscript', role: 'manuscript' }),
  Object.freeze({ inputKey: 'slideNotes', role: 'slide-notes' })
]);

class NativeSermonMaterialIntakeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'NativeSermonMaterialIntakeError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function fail(code, message, details = {}) {
  throw new NativeSermonMaterialIntakeError(code, message, details);
}

function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactRecord(value, expectedKeys, field, code = 'INVALID_INTAKE') {
  if (!isPlainRecord(value)) {
    fail(code, `${field} must be a plain object.`, { field });
  }
  const keys = Reflect.ownKeys(value);
  const expected = [...expectedKeys].sort();
  if (
    keys.some(key => typeof key !== 'string')
    || keys.length !== expected.length
    || keys.slice().sort().some((key, index) => key !== expected[index])
  ) {
    fail(code, `${field} must contain exactly the supported fields.`, { field });
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor
      || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
      || descriptor.enumerable !== true
    ) {
      fail(code, `${field}.${key} must be an enumerable own data property.`, {
        field,
        key
      });
    }
  }
  return value;
}

function denseArray(value, field, maximum = 2, code = 'INVALID_INTAKE') {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    fail(code, `${field} must be a plain array.`, { field });
  }
  if (value.length > maximum) {
    fail(code, `${field} may contain at most ${maximum} entries.`, {
      field,
      maximum
    });
  }
  const keys = Reflect.ownKeys(value);
  const expected = [
    ...Array.from({ length: value.length }, (_unused, index) => String(index)),
    'length'
  ];
  if (
    keys.length !== expected.length
    || expected.some(key => !keys.includes(key))
  ) {
    fail(code, `${field} must be dense and contain no extra properties.`, {
      field
    });
  }
  return value;
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

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function identifier(value, field, code = 'INVALID_INTAKE_BINDING') {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    fail(code, `${field} must be a canonical identifier.`, { field });
  }
  return value;
}

function revision(value, field, code = 'INVALID_INTAKE_BINDING') {
  if (typeof value !== 'string' || !REVISION_PATTERN.test(value)) {
    fail(code, `${field} must be a lowercase SHA-256 digest.`, { field });
  }
  return value;
}

function resourceId(value, field) {
  if (typeof value !== 'string' || !RESOURCE_ID_PATTERN.test(value)) {
    fail(
      'INVALID_INTAKE_BINDING',
      `${field} must identify one exact embedded sermon resource.`,
      { field }
    );
  }
  return value;
}

function hasUnpairedSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function language(value, field) {
  if (typeof value !== 'string') {
    fail('INVALID_MATERIAL_LANGUAGE', `${field} must be a language tag.`, {
      field
    });
  }
  const normalized = value.trim().normalize('NFC').toLowerCase();
  if (!LANGUAGE_PATTERN.test(normalized)) {
    fail(
      'INVALID_MATERIAL_LANGUAGE',
      `${field} must be a BCP-47-style language tag such as en, ru, or mul.`,
      { field }
    );
  }
  return normalized;
}

function singleLine(value, field, maximum = 200) {
  if (typeof value !== 'string') {
    fail('INVALID_MATERIAL_METADATA', `${field} must be text.`, { field });
  }
  const normalized = value.trim().normalize('NFC');
  if (
    normalized.length > maximum
    || DISALLOWED_SINGLE_LINE_CONTROLS.test(normalized)
    || hasUnpairedSurrogate(normalized)
  ) {
    fail(
      'INVALID_MATERIAL_METADATA',
      `${field} must be one safe line of ${maximum} characters or fewer.`,
      { field, maximum }
    );
  }
  return normalized;
}

function materialText(value, field) {
  if (typeof value !== 'string') {
    fail('INVALID_MATERIAL_TEXT', `${field} must be text.`, { field });
  }
  const normalized = value.replace(/\r\n?/g, '\n').normalize('NFC');
  if (!normalized.trim()) {
    fail('MISSING_MATERIAL_TEXT', `${field} cannot be empty.`, { field });
  }
  if (
    DISALLOWED_BODY_CONTROLS.test(normalized)
    || hasUnpairedSurrogate(normalized)
  ) {
    fail(
      'UNSAFE_MATERIAL_TEXT',
      `${field} contains an unsupported Unicode code unit or control character.`,
      { field }
    );
  }
  const sizeBytes = Buffer.byteLength(normalized, 'utf8');
  if (sizeBytes > MAX_SERMON_BODY_ENTRY_BYTES) {
    fail(
      'MATERIAL_TOO_LARGE',
      `${field} must be ${MAX_SERMON_BODY_ENTRY_BYTES} UTF-8 bytes or fewer.`,
      { field, maximumBytes: MAX_SERMON_BODY_ENTRY_BYTES, sizeBytes }
    );
  }
  return { text: normalized, sizeBytes };
}

function normalizeBinding(raw) {
  const binding = exactRecord(raw, [
    'projectId',
    'expectedProjectRevisionId',
    'itemId',
    'resourceId',
    'resourceOwnerId',
    'sermonId',
    'expectedSermonRevisionId'
  ], 'Native sermon material binding', 'INVALID_INTAKE_BINDING');
  return {
    projectId: identifier(binding.projectId, 'Project id'),
    expectedProjectRevisionId: revision(
      binding.expectedProjectRevisionId,
      'Expected project revision'
    ),
    itemId: identifier(binding.itemId, 'Selected service item id'),
    resourceId: resourceId(binding.resourceId, 'Current sermon resource id'),
    resourceOwnerId: identifier(
      binding.resourceOwnerId,
      'Sermon resource owner id'
    ),
    sermonId: identifier(binding.sermonId, 'Sermon id'),
    expectedSermonRevisionId: revision(
      binding.expectedSermonRevisionId,
      'Expected sermon revision'
    )
  };
}

function currentSermon(raw) {
  try {
    return normalizeSermonDocument(raw);
  } catch (error) {
    fail('INVALID_SERMON', 'A canonical sermon is required for material intake.', {
      causeCode: error?.code || null
    });
  }
}

function verifyBinding(document, binding) {
  const currentRevision = sermonDocumentSha256(document);
  if (
    document.id !== binding.sermonId
    || currentRevision !== binding.expectedSermonRevisionId
  ) {
    fail(
      'SERMON_REVISION_MISMATCH',
      'The linked sermon changed before pasted material was reviewed.',
      {
        expectedSermonId: binding.sermonId,
        currentSermonId: document.id,
        expectedRevisionId: binding.expectedSermonRevisionId,
        currentRevisionId: currentRevision
      }
    );
  }
  const expectedResourceId = `sha256:${currentRevision}`;
  if (binding.resourceId !== expectedResourceId) {
    fail(
      'SERMON_RESOURCE_MISMATCH',
      'The pasted-material review does not identify the exact embedded sermon revision.',
      {
        expectedResourceId,
        currentResourceId: binding.resourceId
      }
    );
  }
  if (document.publication.status === 'archived') {
    fail(
      'ARCHIVED_SERMON',
      'Restore this archived sermon before adding pasted material.'
    );
  }
}

function materialRecord(role, raw, currentDocument) {
  const field = role === 'manuscript' ? 'Pastor manuscript' : 'Sermon slide notes';
  const input = exactRecord(
    raw,
    ['text', 'language', 'providedBy'],
    field,
    'INVALID_MATERIAL'
  );
  const normalizedText = materialText(input.text, field);
  const normalizedLanguage = language(input.language, `${field} language`);
  const providedBy = singleLine(input.providedBy, `${field} providedBy`);
  const digest = sha256(Buffer.from(normalizedText.text, 'utf8'));
  const sourceId = `source:paste:${role}:${normalizedLanguage}`;
  const bodyId = `body:paste:${role}:${normalizedLanguage}`;
  const sources = currentDocument.sources || [];
  const bodies = currentDocument.body || [];
  const managedSources = sources.filter(source => {
    const languages = source.languages || [source.language || 'und'];
    return source.kind === role
      && languages.length === 1
      && languages[0] === normalizedLanguage
      && source.provenance?.sourceSystem === 'syncshow-native-paste';
  });
  if (managedSources.length > 1) {
    fail(
      'AMBIGUOUS_MANAGED_MATERIAL',
      `${field} has more than one SyncShow-pasted source for this language.`,
      { role, language: normalizedLanguage }
    );
  }
  const previousSource = managedSources[0] || null;
  const linkedBodies = previousSource
    ? bodies.filter(body => body.sourceId === previousSource.id)
    : [];
  if (
    linkedBodies.length > 1
    || (
      linkedBodies.length === 1
      && (
        linkedBodies[0].kind !== role
        || linkedBodies[0].language !== normalizedLanguage
      )
    )
  ) {
    fail(
      'AMBIGUOUS_MANAGED_MATERIAL',
      `${field} does not have one unambiguous SyncShow-pasted body entry.`,
      { role, language: normalizedLanguage }
    );
  }
  const previousBody = linkedBodies[0] || null;
  const sourceIdOccupant = sources.find(source => source.id === sourceId) || null;
  const bodyIdOccupant = bodies.find(body => body.id === bodyId) || null;
  if (
    (sourceIdOccupant && sourceIdOccupant.id !== previousSource?.id)
    || (bodyIdOccupant && bodyIdOccupant.id !== previousBody?.id)
  ) {
    fail(
      'MATERIAL_ID_COLLISION',
      `${field} cannot use its stable pasted-material identity because unrelated content owns it.`,
      { role, language: normalizedLanguage, sourceId, bodyId }
    );
  }

  const source = {
    id: sourceId,
    kind: role,
    fileName: `pasted-${role}-${normalizedLanguage}.txt`,
    mediaType: 'text/plain',
    sha256: digest,
    sizeBytes: normalizedText.sizeBytes,
    provenance: {
      providedBy,
      receivedAt: null,
      sourceSystem: 'syncshow-native-paste',
      externalId: `native-paste:${role}:${normalizedLanguage}`
    },
    languages: [normalizedLanguage]
  };
  const body = {
    id: bodyId,
    kind: role,
    language: normalizedLanguage,
    sourceId,
    sectionId: null,
    text: normalizedText.text
  };
  const unchanged = Boolean(
    previousSource
    && previousBody
    && previousSource.id === sourceId
    && previousBody.id === bodyId
    && previousSource.sha256 === digest
    && previousSource.sizeBytes === normalizedText.sizeBytes
    && previousBody.text === normalizedText.text
  );
  const action = unchanged
    ? 'unchanged'
    : previousSource || previousBody
      ? 'replace'
      : 'add';
  const retainedSource = unchanged ? previousSource : source;
  const retainedBody = unchanged ? previousBody : body;
  return {
    role,
    language: normalizedLanguage,
    providedBy: unchanged
      ? String(previousSource.provenance?.providedBy || '')
      : providedBy,
    sha256: digest,
    sizeBytes: normalizedText.sizeBytes,
    change: {
      action,
      previousSourceId: previousSource?.id || null,
      previousBodyEntryId: previousBody?.id || null
    },
    source: retainedSource,
    body: retainedBody
  };
}

function mergeMaterialRecords(existing, materials, {
  previousIdKey,
  nextRecordKey
}) {
  const replacements = new Map();
  const appended = [];
  for (const material of materials) {
    if (material.change.action === 'unchanged') continue;
    const previousId = material.change[previousIdKey];
    if (previousId) replacements.set(previousId, material[nextRecordKey]);
    else appended.push(material[nextRecordKey]);
  }
  const replaced = new Set();
  const merged = existing.map(record => {
    const replacement = replacements.get(record.id);
    if (!replacement) return record;
    replaced.add(record.id);
    return replacement;
  });
  for (const [previousId, replacement] of replacements) {
    if (!replaced.has(previousId)) merged.push(replacement);
  }
  return [...merged, ...appended];
}

function documentWithMaterials(document, materials, { resetPublication = false } = {}) {
  const writable = upgradeSermonDocument(document);
  const sourceReplacementIds = new Map(materials
    .filter(material =>
      material.change.action === 'replace'
      && material.change.previousSourceId)
    .map(material => [
      material.change.previousSourceId,
      material.source.id
    ]));
  const changed = materials.some(material => material.change.action !== 'unchanged');
  const publication = resetPublication
    && changed
    && ['ready', 'published'].includes(writable.publication.status)
    ? {
        ...writable.publication,
        status: 'draft',
        publishedAt: null
      }
    : writable.publication;
  return normalizeSermonDocument({
    ...writable,
    schemaVersion: SERMON_SCHEMA_VERSION,
    sources: mergeMaterialRecords(writable.sources, materials, {
      previousIdKey: 'previousSourceId',
      nextRecordKey: 'source'
    }),
    body: mergeMaterialRecords(writable.body, materials, {
      previousIdKey: 'previousBodyEntryId',
      nextRecordKey: 'body'
    }),
    references: writable.references.map(reference => (
      sourceReplacementIds.has(reference.sourceId)
        ? {
            ...reference,
            sourceId: sourceReplacementIds.get(reference.sourceId)
          }
        : reference
    )),
    publication
  });
}

function verifyCandidateCapacity(document, materials) {
  try {
    documentWithMaterials(document, materials);
  } catch (error) {
    if (error instanceof NativeSermonMaterialIntakeError) throw error;
    fail(
      'MATERIAL_CAPACITY_EXCEEDED',
      'The reviewed pasted material does not fit in one canonical sermon revision.',
      { causeCode: error?.code || null }
    );
  }
}

function reviewMaterials(materials) {
  return materials.map(material => ({
    role: material.role,
    language: material.language,
    action: material.change.action,
    sha256: material.sha256,
    sizeBytes: material.sizeBytes
  }));
}

function materialChanges(materials) {
  return materials.map(material => ({
    role: material.role,
    language: material.language,
    action: material.change.action,
    previousSourceId: material.change.previousSourceId,
    previousBodyEntryId: material.change.previousBodyEntryId,
    nextSourceId: material.source.id,
    nextBodyEntryId: material.body.id
  }));
}

function buildNativeSermonMaterialProposal(options = {}) {
  const input = exactRecord(
    options,
    ['sermon', 'binding', 'materials'],
    'Native sermon material intake'
  );
  const document = currentSermon(input.sermon);
  const binding = normalizeBinding(input.binding);
  verifyBinding(document, binding);
  const rawMaterials = exactRecord(
    input.materials,
    ['manuscript', 'slideNotes'],
    'Native sermon materials',
    'INVALID_MATERIAL'
  );

  const materials = [];
  let totalBytes = 0;
  for (const definition of MATERIAL_DEFINITIONS) {
    const value = rawMaterials[definition.inputKey];
    if (value === null) continue;
    const material = materialRecord(definition.role, value, document);
    totalBytes += material.sizeBytes;
    if (totalBytes > MAX_SERMON_BODY_BYTES) {
      fail(
        'MATERIAL_BODY_TOO_LARGE',
        `Pasted sermon material must be ${MAX_SERMON_BODY_BYTES} UTF-8 bytes or fewer in total.`,
        { maximumBytes: MAX_SERMON_BODY_BYTES, sizeBytes: totalBytes }
      );
    }
    materials.push(material);
  }
  if (materials.length === 0) {
    fail(
      'MISSING_MATERIAL',
      'Paste the pastor manuscript, the sermon slide notes, or both.'
    );
  }
  verifyCandidateCapacity(document, materials);

  const reviewBasis = {
    binding,
    materials
  };
  const reviewFingerprint = sha256(canonicalJson(reviewBasis));
  return deepFreeze({
    schemaVersion: NATIVE_SERMON_MATERIAL_PROPOSAL_SCHEMA_VERSION,
    kind: NATIVE_SERMON_MATERIAL_PROPOSAL_KIND,
    binding,
    materials,
    review: {
      statementId: NATIVE_SERMON_MATERIAL_REVIEW_STATEMENT_ID,
      statement: NATIVE_SERMON_MATERIAL_REVIEW_STATEMENT,
      reviewFingerprint,
      materials: reviewMaterials(materials)
    }
  });
}

function inspectProposalShape(raw) {
  const proposal = exactRecord(raw, [
    'schemaVersion',
    'kind',
    'binding',
    'materials',
    'review'
  ], 'Native sermon material proposal', 'INVALID_MATERIAL_PROPOSAL');
  if (
    proposal.schemaVersion !== NATIVE_SERMON_MATERIAL_PROPOSAL_SCHEMA_VERSION
    || proposal.kind !== NATIVE_SERMON_MATERIAL_PROPOSAL_KIND
  ) {
    fail(
      'UNSUPPORTED_MATERIAL_PROPOSAL',
      'The native sermon material proposal uses an unsupported schema.'
    );
  }
  denseArray(
    proposal.materials,
    'Native sermon material proposal materials',
    2,
    'INVALID_MATERIAL_PROPOSAL'
  );
  exactRecord(proposal.review, [
    'statementId',
    'statement',
    'reviewFingerprint',
    'materials'
  ], 'Native sermon material proposal review', 'INVALID_MATERIAL_PROPOSAL');
  denseArray(
    proposal.review.materials,
    'Native sermon material proposal review materials',
    2,
    'INVALID_MATERIAL_PROPOSAL'
  );
  for (const [index, material] of proposal.materials.entries()) {
    exactRecord(material, [
      'role',
      'language',
      'providedBy',
      'sha256',
      'sizeBytes',
      'change',
      'source',
      'body'
    ], `Native sermon material proposal entry ${index + 1}`, 'INVALID_MATERIAL_PROPOSAL');
    exactRecord(material.change, [
      'action',
      'previousSourceId',
      'previousBodyEntryId'
    ], `Native sermon material proposal change ${index + 1}`, 'INVALID_MATERIAL_PROPOSAL');
    exactRecord(material.source, [
      'id',
      'kind',
      'fileName',
      'mediaType',
      'sha256',
      'sizeBytes',
      'provenance',
      'languages'
    ], `Native sermon material proposal source ${index + 1}`, 'INVALID_MATERIAL_PROPOSAL');
    exactRecord(material.source.provenance, [
      'providedBy',
      'receivedAt',
      'sourceSystem',
      'externalId'
    ], `Native sermon material proposal provenance ${index + 1}`, 'INVALID_MATERIAL_PROPOSAL');
    denseArray(
      material.source.languages,
      `Native sermon material proposal source languages ${index + 1}`,
      1,
      'INVALID_MATERIAL_PROPOSAL'
    );
    exactRecord(material.body, [
      'id',
      'kind',
      'language',
      'sourceId',
      'sectionId',
      'text'
    ], `Native sermon material proposal body ${index + 1}`, 'INVALID_MATERIAL_PROPOSAL');
  }
  for (const [index, material] of proposal.review.materials.entries()) {
    exactRecord(material, [
      'role',
      'language',
      'action',
      'sha256',
      'sizeBytes'
    ], `Native sermon material review entry ${index + 1}`, 'INVALID_MATERIAL_PROPOSAL');
  }
  return proposal;
}

function normalizeNativeSermonMaterialProposal(raw, rawSermon) {
  const proposal = inspectProposalShape(raw);
  const materialsByRole = new Map();
  for (const material of proposal.materials) {
    if (!['manuscript', 'slide-notes'].includes(material.role)) {
      fail(
        'INVALID_MATERIAL_PROPOSAL',
        'A native sermon material proposal contains an unsupported role.'
      );
    }
    if (materialsByRole.has(material.role)) {
      fail(
        'INVALID_MATERIAL_PROPOSAL',
        'A native sermon material proposal repeats one role.'
      );
    }
    materialsByRole.set(material.role, material);
  }
  const rebuilt = buildNativeSermonMaterialProposal({
    sermon: rawSermon,
    binding: proposal.binding,
    materials: {
      manuscript: materialsByRole.has('manuscript')
        ? {
            text: materialsByRole.get('manuscript').body.text,
            language: materialsByRole.get('manuscript').language,
            providedBy: materialsByRole.get('manuscript').providedBy
          }
        : null,
      slideNotes: materialsByRole.has('slide-notes')
        ? {
            text: materialsByRole.get('slide-notes').body.text,
            language: materialsByRole.get('slide-notes').language,
            providedBy: materialsByRole.get('slide-notes').providedBy
          }
        : null
    }
  });
  if (canonicalJson(proposal) !== canonicalJson(rebuilt)) {
    fail(
      'NONCANONICAL_MATERIAL_PROPOSAL',
      'The native sermon material proposal changed after review.'
    );
  }
  return rebuilt;
}

function normalizeConfirmation(raw, proposal) {
  const confirmation = exactRecord(raw, [
    'confirmed',
    'statementId',
    'reviewFingerprint',
    'materials'
  ], 'Native sermon material confirmation', 'INVALID_MATERIAL_CONFIRMATION');
  if (confirmation.confirmed !== true) {
    fail(
      'MATERIAL_REVIEW_REQUIRED',
      'Confirm every pasted text block, its role, and its language before saving.'
    );
  }
  if (confirmation.statementId !== NATIVE_SERMON_MATERIAL_REVIEW_STATEMENT_ID) {
    fail(
      'MATERIAL_REVIEW_STATEMENT_MISMATCH',
      'The pasted-material confirmation statement changed after review.'
    );
  }
  if (confirmation.reviewFingerprint !== proposal.review.reviewFingerprint) {
    fail(
      'MATERIAL_REVIEW_FINGERPRINT_MISMATCH',
      'The pasted material changed after it was reviewed.'
    );
  }
  denseArray(
    confirmation.materials,
    'Native sermon material confirmation materials',
    2,
    'INVALID_MATERIAL_CONFIRMATION'
  );
  for (const [index, material] of confirmation.materials.entries()) {
    exactRecord(material, [
      'role',
      'language',
      'action',
      'sha256',
      'sizeBytes'
    ], `Native sermon material confirmation entry ${index + 1}`, 'INVALID_MATERIAL_CONFIRMATION');
  }
  if (
    canonicalJson(confirmation.materials)
      !== canonicalJson(proposal.review.materials)
  ) {
    fail(
      'MATERIAL_REVIEW_EVIDENCE_MISMATCH',
      'The confirmed pasted-material summary does not match the reviewed text.'
    );
  }
  return {
    confirmed: true,
    statementId: NATIVE_SERMON_MATERIAL_REVIEW_STATEMENT_ID,
    statement: NATIVE_SERMON_MATERIAL_REVIEW_STATEMENT,
    reviewFingerprint: proposal.review.reviewFingerprint,
    materials: proposal.review.materials
  };
}

function sourceObjects(materials) {
  const objects = [];
  const seen = new Set();
  for (const material of materials) {
    if (material.change.action === 'unchanged') continue;
    if (seen.has(material.sha256)) continue;
    seen.add(material.sha256);
    objects.push({
      objectId: `sha256:${material.sha256}`,
      sha256: material.sha256,
      sizeBytes: material.sizeBytes,
      mediaType: 'text/plain',
      text: material.body.text
    });
  }
  return objects;
}

function confirmNativeSermonMaterialProposal(
  rawProposal,
  rawSermon,
  rawConfirmation
) {
  const proposal = normalizeNativeSermonMaterialProposal(
    rawProposal,
    rawSermon
  );
  const confirmation = normalizeConfirmation(rawConfirmation, proposal);
  const basis = {
    binding: proposal.binding,
    reviewFingerprint: proposal.review.reviewFingerprint,
    confirmation,
    changes: materialChanges(proposal.materials),
    sourceObjects: sourceObjects(proposal.materials),
    sources: proposal.materials.map(material => material.source),
    bodyEntries: proposal.materials.map(material => material.body)
  };
  const commitFingerprint = sha256(canonicalJson(basis));
  return deepFreeze({
    schemaVersion: NATIVE_SERMON_MATERIAL_COMMIT_SCHEMA_VERSION,
    kind: NATIVE_SERMON_MATERIAL_COMMIT_KIND,
    ...basis,
    commitFingerprint
  });
}

function inspectCommitShape(raw) {
  const commit = exactRecord(raw, [
    'schemaVersion',
    'kind',
    'binding',
    'reviewFingerprint',
    'confirmation',
    'changes',
    'sourceObjects',
    'sources',
    'bodyEntries',
    'commitFingerprint'
  ], 'Native sermon material commit', 'INVALID_MATERIAL_COMMIT');
  if (
    commit.schemaVersion !== NATIVE_SERMON_MATERIAL_COMMIT_SCHEMA_VERSION
    || commit.kind !== NATIVE_SERMON_MATERIAL_COMMIT_KIND
  ) {
    fail(
      'UNSUPPORTED_MATERIAL_COMMIT',
      'The native sermon material commit uses an unsupported schema.'
    );
  }
  denseArray(
    commit.changes,
    'Native sermon material commit changes',
    2,
    'INVALID_MATERIAL_COMMIT'
  );
  denseArray(
    commit.sources,
    'Native sermon material commit sources',
    2,
    'INVALID_MATERIAL_COMMIT'
  );
  denseArray(
    commit.bodyEntries,
    'Native sermon material commit body entries',
    2,
    'INVALID_MATERIAL_COMMIT'
  );
  denseArray(
    commit.sourceObjects,
    'Native sermon material commit source objects',
    2,
    'INVALID_MATERIAL_COMMIT'
  );
  for (const [index, object] of commit.sourceObjects.entries()) {
    exactRecord(object, [
      'objectId',
      'sha256',
      'sizeBytes',
      'mediaType',
      'text'
    ], `Native sermon material source object ${index + 1}`, 'INVALID_MATERIAL_COMMIT');
  }
  for (const [index, change] of commit.changes.entries()) {
    exactRecord(change, [
      'role',
      'language',
      'action',
      'previousSourceId',
      'previousBodyEntryId',
      'nextSourceId',
      'nextBodyEntryId'
    ], `Native sermon material change ${index + 1}`, 'INVALID_MATERIAL_COMMIT');
  }
  exactRecord(commit.confirmation, [
    'confirmed',
    'statementId',
    'statement',
    'reviewFingerprint',
    'materials'
  ], 'Native sermon material commit confirmation', 'INVALID_MATERIAL_COMMIT');
  return commit;
}

function normalizeNativeSermonMaterialCommit(raw, rawSermon) {
  const commit = inspectCommitShape(raw);
  if (commit.sources.length !== commit.bodyEntries.length) {
    fail(
      'INVALID_MATERIAL_COMMIT',
      'The native sermon material commit has mismatched source and body counts.'
    );
  }
  const materials = {
    manuscript: null,
    slideNotes: null
  };
  for (const body of commit.bodyEntries) {
    const source = commit.sources.find(candidate => candidate.id === body.sourceId);
    if (!source || !['manuscript', 'slide-notes'].includes(body.kind)) {
      fail(
        'INVALID_MATERIAL_COMMIT',
        'The native sermon material commit has a mismatched source and body.'
      );
    }
    const key = body.kind === 'manuscript' ? 'manuscript' : 'slideNotes';
    if (materials[key] !== null) {
      fail(
        'INVALID_MATERIAL_COMMIT',
        'The native sermon material commit repeats one material role.'
      );
    }
    materials[key] = {
      text: body.text,
      language: body.language,
      providedBy: source.provenance?.providedBy
    };
  }
  const proposal = buildNativeSermonMaterialProposal({
    sermon: rawSermon,
    binding: commit.binding,
    materials
  });
  const expected = confirmNativeSermonMaterialProposal(
    proposal,
    rawSermon,
    {
      confirmed: commit.confirmation.confirmed,
      statementId: commit.confirmation.statementId,
      reviewFingerprint: commit.confirmation.reviewFingerprint,
      materials: commit.confirmation.materials
    }
  );
  if (canonicalJson(commit) !== canonicalJson(expected)) {
    fail(
      'NONCANONICAL_MATERIAL_COMMIT',
      'The confirmed native sermon material changed before it could be applied.'
    );
  }
  return expected;
}

function materialsFromCommit(commit) {
  return commit.changes.map(change => {
    const source = commit.sources.find(candidate =>
      candidate.id === change.nextSourceId);
    const body = commit.bodyEntries.find(candidate =>
      candidate.id === change.nextBodyEntryId);
    if (!source || !body || body.sourceId !== source.id) {
      fail(
        'INVALID_MATERIAL_COMMIT',
        'The confirmed material change no longer matches its source and body.'
      );
    }
    return {
      role: change.role,
      language: change.language,
      providedBy: String(source.provenance?.providedBy || ''),
      sha256: source.sha256,
      sizeBytes: source.sizeBytes,
      change: {
        action: change.action,
        previousSourceId: change.previousSourceId,
        previousBodyEntryId: change.previousBodyEntryId
      },
      source,
      body
    };
  });
}

function applyNativeSermonMaterialCommit(rawSermon, rawCommit) {
  const document = currentSermon(rawSermon);
  const commit = normalizeNativeSermonMaterialCommit(rawCommit, document);
  const materials = materialsFromCommit(commit);
  let nextDocument;
  try {
    nextDocument = documentWithMaterials(document, materials, {
      resetPublication: true
    });
  } catch (error) {
    if (error instanceof NativeSermonMaterialIntakeError) throw error;
    fail(
      'MATERIAL_APPLICATION_FAILED',
      'The confirmed pasted material could not be applied to the exact sermon.',
      { causeCode: error?.code || null }
    );
  }
  const nextSermonRevision = sermonDocumentSha256(nextDocument);
  const nextResourceId = `sha256:${nextSermonRevision}`;
  const addedRoles = commit.changes
    .filter(change => change.action === 'add')
    .map(change => change.role);
  const replacedRoles = commit.changes
    .filter(change => change.action === 'replace')
    .map(change => change.role);
  const unchangedRoles = commit.changes
    .filter(change => change.action === 'unchanged')
    .map(change => change.role);
  const requiresCommit = addedRoles.length > 0 || replacedRoles.length > 0;
  return deepFreeze({
    schemaVersion: NATIVE_SERMON_MATERIAL_APPLICATION_SCHEMA_VERSION,
    kind: NATIVE_SERMON_MATERIAL_APPLICATION_KIND,
    document: nextDocument,
    revision: nextSermonRevision,
    sourceObjects: commit.sourceObjects,
    changes: commit.changes,
    addedRoles,
    replacedRoles,
    unchangedRoles,
    requiresCommit,
    changedSourceIds: commit.changes
      .filter(change => change.action !== 'unchanged')
      .map(change => change.nextSourceId),
    changedBodyEntryIds: commit.changes
      .filter(change => change.action !== 'unchanged')
      .map(change => change.nextBodyEntryId),
    confirmation: commit.confirmation,
    commitFingerprint: commit.commitFingerprint,
    transaction: {
      projectId: commit.binding.projectId,
      expectedProjectRevisionId: commit.binding.expectedProjectRevisionId,
      itemId: commit.binding.itemId,
      resourceOwnerId: commit.binding.resourceOwnerId,
      previousResourceId: commit.binding.resourceId,
      nextResourceId,
      sermonId: commit.binding.sermonId,
      expectedSermonRevision: commit.binding.expectedSermonRevisionId,
      nextSermonRevision,
      required: requiresCommit,
      reason: NATIVE_SERMON_MATERIAL_REASON
    }
  });
}

module.exports = {
  NATIVE_SERMON_MATERIAL_APPLICATION_KIND,
  NATIVE_SERMON_MATERIAL_APPLICATION_SCHEMA_VERSION,
  NATIVE_SERMON_MATERIAL_COMMIT_KIND,
  NATIVE_SERMON_MATERIAL_COMMIT_SCHEMA_VERSION,
  NATIVE_SERMON_MATERIAL_PROPOSAL_KIND,
  NATIVE_SERMON_MATERIAL_PROPOSAL_SCHEMA_VERSION,
  NATIVE_SERMON_MATERIAL_REASON,
  NATIVE_SERMON_MATERIAL_REVIEW_STATEMENT,
  NATIVE_SERMON_MATERIAL_REVIEW_STATEMENT_ID,
  NativeSermonMaterialIntakeError,
  applyNativeSermonMaterialCommit,
  buildNativeSermonMaterialProposal,
  confirmNativeSermonMaterialProposal,
  normalizeNativeSermonMaterialCommit,
  normalizeNativeSermonMaterialProposal
};
