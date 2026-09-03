'use strict';

const crypto = require('crypto');
const path = require('path');

const MAX_SERVICE_INPUTS = 32;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const LANGUAGE_PATTERN = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/;
const PPTX_MEDIA_TYPE =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation';

class ServiceSermonPacketError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ServiceSermonPacketError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new ServiceSermonPacketError(code, message, details);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function exactText(value, label, maximum, { required = true } = {}) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string') fail('INVALID_PACKET_SOURCE', `${label} must be text.`);
  const normalized = value.trim().normalize('NFC');
  if (required && !normalized) {
    fail('INVALID_PACKET_SOURCE', `${label} is required.`);
  }
  if (
    normalized.length > maximum
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(normalized)
  ) {
    fail('INVALID_PACKET_SOURCE', `${label} contains unsupported or excessive text.`);
  }
  return normalized;
}

function exactId(value, label) {
  const normalized = exactText(value, label, 128);
  if (!ID_PATTERN.test(normalized)) {
    fail('INVALID_PACKET_SOURCE', `${label} is invalid.`);
  }
  return normalized;
}

function exactSha256(value, label) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    fail('INVALID_PACKET_SOURCE', `${label} is invalid.`);
  }
  return value;
}

function exactSize(value, label) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 128 * 1024 * 1024) {
    fail('INVALID_PACKET_SOURCE', `${label} is invalid.`);
  }
  return value;
}

function exactFileName(value, label) {
  const normalized = exactText(value, label, 255);
  if (
    normalized === '.'
    || normalized === '..'
    || normalized.includes('/')
    || normalized.includes('\\')
    || /^[A-Za-z]:/.test(normalized)
  ) {
    fail('INVALID_PACKET_SOURCE', `${label} is invalid.`);
  }
  return path.basename(normalized);
}

function exactAbsolutePath(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) {
    fail('INVALID_PACKET_SOURCE', `${label} is invalid.`);
  }
  return path.resolve(value);
}

function normalizeLanguages(value, label) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) {
    fail('INVALID_PACKET_SOURCE', `${label} must include between one and eight languages.`);
  }
  const languages = [...new Set(value.map((language, index) => {
    const normalized = exactText(language, `${label} ${index + 1}`, 35).toLowerCase();
    if (!LANGUAGE_PATTERN.test(normalized)) {
      fail(
        'INVALID_PACKET_SOURCE',
        `${label} must use language tags such as en or ru.`
      );
    }
    return normalized;
  }))].sort();
  return languages;
}

function humanizeRole(roleId) {
  return roleId
    .replace(/[-_.:]+/g, ' ')
    .replace(/\b\p{L}/gu, character => character.toLocaleUpperCase('en-US'));
}

function inferServiceInputLanguages(input) {
  const searchable = `${input.roleId || ''} ${input.sourceName || ''}`
    .normalize('NFC')
    .toLocaleLowerCase('en-US');
  const matches = (...tokens) => tokens.some(token => token.test(searchable));
  if (matches(/(^|[^a-z])(?:rus|russian)(?:[^a-z]|$)/u, /рус/u)) return ['ru'];
  if (matches(/(^|[^a-z])(?:ukr|ukrainian)(?:[^a-z]|$)/u, /укр/u)) return ['uk'];
  if (matches(/(^|[^a-z])(?:eng|english)(?:[^a-z]|$)/u)) return ['en'];
  if (matches(/(^|[^a-z])(?:spa|spanish)(?:[^a-z]|$)/u, /español/u)) return ['es'];
  return ['und'];
}

function fingerprintPayload(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    fail('INVALID_SERVICE_SET', 'The current service snapshot is invalid.');
  }
  const id = exactId(manifest.id, 'Service snapshot id');
  const serviceDate = exactText(manifest.serviceDate, 'Service date', 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(serviceDate)) {
    fail('INVALID_SERVICE_SET', 'The current service date is invalid.');
  }
  const entries = Object.entries(manifest.inputs || {});
  if (entries.length < 1 || entries.length > MAX_SERVICE_INPUTS) {
    fail(
      'INVALID_SERVICE_SET',
      `The current service must contain between one and ${MAX_SERVICE_INPUTS} presentations.`
    );
  }
  const inputs = entries
    .sort(([left], [right]) => left.localeCompare(right, 'en'))
    .map(([roleKey, input]) => {
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        fail('INVALID_SERVICE_SET', 'One current service presentation is invalid.');
      }
      const roleId = exactId(input.roleId, 'Presentation role');
      if (roleId !== roleKey) {
        fail('INVALID_SERVICE_SET', 'A current service presentation changed roles.');
      }
      const pinnedPath = exactAbsolutePath(input.pinnedPath, 'Pinned presentation');
      const sourceName = exactFileName(input.sourceName, 'Presentation file name');
      if (
        path.extname(pinnedPath).toLowerCase() !== '.pptx'
        || path.extname(sourceName).toLowerCase() !== '.pptx'
      ) {
        fail(
          'UNSUPPORTED_SERVICE_PRESENTATION',
          'Only verified PPTX service presentations can be preserved in a sermon packet.'
        );
      }
      return {
        roleId,
        assetId: exactId(input.assetId, 'Presentation asset'),
        sourceName,
        pinnedPath,
        sizeBytes: exactSize(input.size, 'Presentation size'),
        sha256: exactSha256(input.sha256, 'Presentation checksum')
      };
    });
  return {
    schemaVersion: manifest.schemaVersion,
    id,
    name: exactText(
      manifest.name || `Service ${serviceDate}`,
      'Service snapshot name',
      300
    ),
    profileId: exactId(manifest.profileId, 'Service profile'),
    serviceDate,
    createdAt: exactText(manifest.createdAt, 'Service snapshot time', 40),
    inputs
  };
}

function serviceSetFingerprint(manifest) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(fingerprintPayload(manifest)))
    .digest('hex');
}

function sourceExternalId(parts) {
  const digest = crypto
    .createHash('sha256')
    .update(JSON.stringify(parts))
    .digest('hex');
  return `service-set:${digest}`;
}

function buildServiceSermonPacketSourcePlan({
  manifest,
  manuscript,
  manuscriptPath,
  manuscriptLanguages,
  manuscriptProvidedBy,
  providedBy = '',
  receivedAt,
  createSourceId
} = {}) {
  const serviceSet = fingerprintPayload(manifest);
  if (!manuscript || typeof manuscript !== 'object' || Array.isArray(manuscript)) {
    fail('INVALID_PACKET_SOURCE', 'The selected manuscript review is invalid.');
  }
  if (typeof createSourceId !== 'function') {
    fail('INVALID_PACKET_SOURCE', 'The source identity generator is unavailable.');
  }
  const exactReceivedAt = exactText(receivedAt, 'Source received time', 40);
  if (!Number.isFinite(Date.parse(exactReceivedAt))) {
    fail('INVALID_PACKET_SOURCE', 'The source received time is invalid.');
  }
  const manuscriptProvider = exactText(
    manuscriptProvidedBy ?? providedBy,
    'Manuscript provider',
    200,
    { required: false }
  );
  const exactManuscript = {
    fileName: exactFileName(manuscript.fileName, 'Manuscript file name'),
    mediaType: exactText(manuscript.mediaType, 'Manuscript media type', 160),
    sha256: exactSha256(manuscript.sha256, 'Manuscript checksum'),
    sizeBytes: exactSize(manuscript.sizeBytes, 'Manuscript size'),
    defaultKind: exactText(manuscript.defaultKind, 'Manuscript kind', 24)
  };
  if (exactManuscript.defaultKind !== 'manuscript') {
    fail('INVALID_PACKET_SOURCE', 'Choose a manuscript, notes, or transcript document.');
  }
  const exactManuscriptLanguages = normalizeLanguages(
    manuscriptLanguages,
    'Manuscript languages'
  );

  const importPlans = [];
  const publicSources = [];
  for (const input of serviceSet.inputs) {
    const languages = inferServiceInputLanguages(input);
    const sourceId = exactId(createSourceId(), 'Presentation source id');
    const roleLabel = humanizeRole(input.roleId);
    importPlans.push({
      key: `service:${input.roleId}`,
      sourcePath: input.pinnedPath,
      expected: {
        fileName: input.sourceName,
        mediaType: PPTX_MEDIA_TYPE,
        sha256: input.sha256,
        sizeBytes: input.sizeBytes
      },
      importOptions: {
        id: sourceId,
        kind: 'slide-notes',
        fileName: input.sourceName,
        languages,
        provenance: {
          providedBy: '',
          receivedAt: new Date(exactReceivedAt).toISOString(),
          sourceSystem: 'service-set',
          externalId: sourceExternalId([
            serviceSet.id,
            input.roleId,
            input.assetId,
            input.sha256
          ])
        }
      }
    });
    publicSources.push({
      key: `service:${input.roleId}`,
      roleId: input.roleId,
      roleLabel,
      fileName: input.sourceName,
      kind: 'slide-notes',
      languages,
      sha256: input.sha256,
      sizeBytes: input.sizeBytes
    });
  }

  const manuscriptSourceId = exactId(createSourceId(), 'Manuscript source id');
  importPlans.push({
    key: 'manuscript',
    sourcePath: exactAbsolutePath(manuscriptPath, 'Selected manuscript'),
    expected: {
      fileName: exactManuscript.fileName,
      mediaType: exactManuscript.mediaType,
      sha256: exactManuscript.sha256,
      sizeBytes: exactManuscript.sizeBytes
    },
    importOptions: {
      id: manuscriptSourceId,
      kind: 'manuscript',
      languages: exactManuscriptLanguages,
      provenance: {
        providedBy: manuscriptProvider,
        receivedAt: new Date(exactReceivedAt).toISOString(),
        sourceSystem: 'service-sermon-packet',
        externalId: sourceExternalId([
          serviceSet.id,
          'manuscript',
          exactManuscript.sha256
        ])
      }
    }
  });
  publicSources.push({
    key: 'manuscript',
    roleId: null,
    roleLabel: 'Pastor manuscript',
    fileName: exactManuscript.fileName,
    kind: 'manuscript',
    languages: exactManuscriptLanguages,
    sha256: exactManuscript.sha256,
    sizeBytes: exactManuscript.sizeBytes
  });

  return deepFreeze({
    serviceSet: {
      id: serviceSet.id,
      name: serviceSet.name,
      serviceDate: serviceSet.serviceDate
    },
    serviceSetFingerprint: serviceSetFingerprint(manifest),
    importPlans,
    publicSources
  });
}

function importedSourceMatchesPlan(imported, plan) {
  const source = imported?.source;
  const expected = plan?.expected;
  const expectedProvenance = plan?.importOptions?.provenance;
  const provenance = source?.provenance;
  const provenanceMatches = Boolean(
    provenance
    && expectedProvenance
    && typeof provenance === 'object'
    && !Array.isArray(provenance)
    && Object.keys(provenance).length === 4
    && provenance.providedBy === expectedProvenance.providedBy
    && provenance.receivedAt === expectedProvenance.receivedAt
    && provenance.sourceSystem === expectedProvenance.sourceSystem
    && provenance.externalId === expectedProvenance.externalId
  );
  return Boolean(
    source
    && expected
    && source.id === plan.importOptions.id
    && source.kind === plan.importOptions.kind
    && source.fileName === expected.fileName
    && source.mediaType === expected.mediaType
    && source.sha256 === expected.sha256
    && source.sizeBytes === expected.sizeBytes
    && imported.objectId === `sha256:${expected.sha256}`
    && JSON.stringify(source.languages) === JSON.stringify(plan.importOptions.languages)
    && provenanceMatches
  );
}

function serviceSermonPacketSourceDispositions(sermon, sourcePlan) {
  if (!sermon || typeof sermon !== 'object' || Array.isArray(sermon)
    || !Array.isArray(sermon.sources)) {
    fail(
      'INVALID_LINKED_SERMON',
      'The linked sermon packet is not available for current-service source review.'
    );
  }
  if (!sourcePlan || typeof sourcePlan !== 'object' || Array.isArray(sourcePlan)
    || !Array.isArray(sourcePlan.importPlans)
    || !Array.isArray(sourcePlan.publicSources)
    || sourcePlan.importPlans.length !== sourcePlan.publicSources.length) {
    fail(
      'INVALID_PACKET_SOURCE',
      'The reviewed current-service source plan is incomplete.'
    );
  }

  const publicByKey = new Map();
  for (const source of sourcePlan.publicSources) {
    const key = exactText(source?.key, 'Reviewed source key', 160);
    if (publicByKey.has(key)) {
      fail(
        'INVALID_PACKET_SOURCE',
        'The reviewed current-service source plan repeats a source.'
      );
    }
    publicByKey.set(key, source);
  }

  const plannedBySha256 = new Map();
  const dispositions = sourcePlan.importPlans.map(plan => {
    const key = exactText(plan?.key, 'Reviewed source key', 160);
    const publicSource = publicByKey.get(key);
    if (!publicSource) {
      fail(
        'INVALID_PACKET_SOURCE',
        'The reviewed current-service source plan is missing a safe source summary.'
      );
    }
    const expectedSha256 = exactSha256(
      plan?.expected?.sha256,
      'Reviewed source checksum'
    );
    const expectedMediaType = exactText(
      plan?.expected?.mediaType,
      'Reviewed source media type',
      160
    );
    const expectedKind = exactText(
      plan?.importOptions?.kind,
      'Reviewed source kind',
      24
    );
    const earlierPlan = plannedBySha256.get(expectedSha256);
    if (
      earlierPlan
      && (
        earlierPlan.kind !== expectedKind
        || earlierPlan.mediaType !== expectedMediaType
        || earlierPlan.sizeBytes !== plan.expected.sizeBytes
      )
    ) {
      fail(
        'DUPLICATE_PACKET_SOURCE_CONFLICT',
        'Two reviewed service files share bytes but use incompatible source metadata.',
        { key }
      );
    }
    if (!earlierPlan) {
      plannedBySha256.set(expectedSha256, {
        kind: expectedKind,
        mediaType: expectedMediaType,
        sizeBytes: plan.expected.sizeBytes
      });
    }
    const matches = sermon.sources.filter(source =>
      source?.sha256 === expectedSha256);
    if (matches.length > 1) {
      fail(
        'AMBIGUOUS_EXISTING_PACKET_SOURCE',
        'The linked sermon already contains more than one record for a reviewed service file.',
        { key }
      );
    }
    const existing = matches[0] || null;
    if (
      existing
      && (
        existing.kind !== expectedKind
        || existing.mediaType !== expectedMediaType
        || existing.sizeBytes !== plan.expected.sizeBytes
      )
    ) {
      fail(
        'EXISTING_PACKET_SOURCE_CONFLICT',
        'A reviewed service file is already attached with incompatible source metadata.',
        { key }
      );
    }
    return {
      key,
      disposition: existing || earlierPlan ? 'reuse' : 'add',
      roleId: publicSource.roleId,
      roleLabel: publicSource.roleLabel,
      fileName: existing?.fileName || publicSource.fileName,
      kind: existing?.kind || publicSource.kind,
      languages: existing
        ? [...existing.languages]
        : [...publicSource.languages],
      sha256: publicSource.sha256,
      sizeBytes: publicSource.sizeBytes
    };
  });
  if (publicByKey.size !== dispositions.length) {
    fail(
      'INVALID_PACKET_SOURCE',
      'The reviewed current-service source plan contains an unmatched safe source summary.'
    );
  }
  return deepFreeze(dispositions);
}

module.exports = {
  MAX_SERVICE_INPUTS,
  ServiceSermonPacketError,
  buildServiceSermonPacketSourcePlan,
  importedSourceMatchesPlan,
  inferServiceInputLanguages,
  serviceSermonPacketSourceDispositions,
  serviceSetFingerprint
};
