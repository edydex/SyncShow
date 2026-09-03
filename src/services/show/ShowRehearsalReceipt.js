'use strict';

const SHOW_REHEARSAL_RECEIPT_SCHEMA_VERSION = 1;
const SHOW_REHEARSAL_RECEIPT_KIND =
  'syncshow-show-rehearsal-receipt';
const MAX_SHOW_REHEARSAL_RECEIPT_BYTES = 16 * 1024 * 1024;
const MAX_SHOW_REHEARSAL_ASSETS = 2000;
const MAX_SHOW_REHEARSAL_OUTPUTS = 16;
const MAX_SHOW_REHEARSAL_CUES = 2000;

const SHOW_KINDS = new Set(['show-package', 'service-set']);
const DECISION_MODES = new Set([
  'direct',
  'mirror',
  'derive-next-text'
]);
const OUTPUT_RENDERERS = new Set([
  'slides',
  'singer-current-next',
  'native-cue'
]);
const NATIVE_VARIANTS = new Set(['singer-current-next']);
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ASSET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const SERVICE_SET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const SHOW_PACKAGE_ID_PATTERN = /^show-[a-f0-9]{64}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const FORBIDDEN_IDS = new Set(['__proto__', 'prototype', 'constructor']);

const EVIDENCE_KEYS = Object.freeze([
  'show',
  'venueProfile',
  'routing',
  'cueCount',
  'cueIds'
]);
const RECEIPT_KEYS = Object.freeze([
  'schemaVersion',
  'kind',
  ...EVIDENCE_KEYS,
  'acknowledgements'
]);

class ShowRehearsalReceiptError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ShowRehearsalReceiptError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function fail(code, message, details = {}) {
  throw new ShowRehearsalReceiptError(code, message, details);
}

function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireExactDataProperties(value, keys, field, code) {
  if (!isPlainRecord(value)) {
    fail(code, `${field} must be a plain object.`, { field });
  }
  const actualKeys = Reflect.ownKeys(value);
  const expectedKeys = [...keys].sort();
  if (
    actualKeys.some(key => typeof key !== 'string')
    || actualKeys.length !== expectedKeys.length
    || actualKeys
      .map(String)
      .sort()
      .some((key, index) => key !== expectedKeys[index])
  ) {
    fail(code, `${field} must contain exactly the supported fields.`, {
      field,
      expected: expectedKeys,
      actual: actualKeys.map(String).sort()
    });
  }
  for (const key of actualKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
      fail(code, `${field}.${key} must be an own data property.`, {
        field,
        key
      });
    }
  }
}

function requireDenseArray(value, field, minimum, maximum, code) {
  if (
    !Array.isArray(value)
    || !Number.isSafeInteger(value.length)
    || value.length < minimum
    || value.length > maximum
  ) {
    fail(
      code,
      `${field} must contain ${minimum} to ${maximum} entries.`,
      { field, minimum, maximum }
    );
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some(key => typeof key !== 'string')) {
    fail(code, `${field} must not contain symbol properties.`, { field });
  }
  const expectedKeys = new Set([
    'length',
    ...Array.from({ length: value.length }, (_, index) => String(index))
  ]);
  if (
    ownKeys.length !== expectedKeys.size
    || ownKeys.some(key => !expectedKeys.has(key))
  ) {
    fail(code, `${field} must be a dense array without extra fields.`, {
      field
    });
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
      fail(code, `${field}[${index}] must be an own data property.`, {
        field,
        index
      });
    }
  }
  return value;
}

function compareAscii(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function exactId(value, field, code, pattern = SAFE_ID_PATTERN) {
  if (
    typeof value !== 'string'
    || !pattern.test(value)
    || FORBIDDEN_IDS.has(value)
  ) {
    fail(code, `${field} is invalid.`, { field });
  }
  return value;
}

function exactSha256(value, field, code) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    fail(code, `${field} must be a lowercase SHA-256 digest.`, { field });
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

function exactDisplayId(value, field, code) {
  if (typeof value === 'number') {
    if (
      !Number.isSafeInteger(value)
      || Object.is(value, -0)
      || value < -2147483648
      || value > 2147483647
    ) {
      fail(code, `${field} must be a safe display identity.`, { field });
    }
    return value;
  }
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > 128
    || Buffer.byteLength(value, 'utf8') > 256
    || value.trim() !== value
    || value.normalize('NFC') !== value
    || /[\u0000-\u001f\u007f-\u009f]/u.test(value)
    || hasUnpairedSurrogate(value)
  ) {
    fail(code, `${field} must be bounded canonical display text.`, {
      field
    });
  }
  return value;
}

function normalizeAssets(rawAssets, code) {
  requireDenseArray(
    rawAssets,
    'show.assets',
    1,
    MAX_SHOW_REHEARSAL_ASSETS,
    code
  );
  const seen = new Set();
  const assets = rawAssets.map((rawAsset, index) => {
    const field = `show.assets[${index}]`;
    requireExactDataProperties(
      rawAsset,
      ['assetId', 'revisionId'],
      field,
      code
    );
    const assetId = exactId(
      rawAsset.assetId,
      `${field}.assetId`,
      code,
      ASSET_ID_PATTERN
    );
    if (seen.has(assetId)) {
      fail(code, 'show.assets cannot repeat an asset identity.', {
        assetId
      });
    }
    seen.add(assetId);
    return {
      assetId,
      revisionId: exactSha256(
        rawAsset.revisionId,
        `${field}.revisionId`,
        code
      )
    };
  });
  return assets.sort((left, right) =>
    compareAscii(left.assetId, right.assetId));
}

function normalizeShow(rawShow, code) {
  if (!isPlainRecord(rawShow) || !SHOW_KINDS.has(rawShow.kind)) {
    fail(
      code,
      'show must identify one exact Show package or ServiceSet.',
      { field: 'show' }
    );
  }
  if (rawShow.kind === 'show-package') {
    requireExactDataProperties(
      rawShow,
      ['kind', 'packageId', 'manifestRevisionId', 'assets'],
      'show',
      code
    );
    return {
      kind: 'show-package',
      packageId: exactId(
        rawShow.packageId,
        'show.packageId',
        code,
        SHOW_PACKAGE_ID_PATTERN
      ),
      manifestRevisionId: exactSha256(
        rawShow.manifestRevisionId,
        'show.manifestRevisionId',
        code
      ),
      assets: normalizeAssets(rawShow.assets, code)
    };
  }
  requireExactDataProperties(
    rawShow,
    ['kind', 'serviceSetId', 'fingerprint', 'assets'],
    'show',
    code
  );
  return {
    kind: 'service-set',
    serviceSetId: exactId(
      rawShow.serviceSetId,
      'show.serviceSetId',
      code,
      SERVICE_SET_ID_PATTERN
    ),
    fingerprint: exactSha256(
      rawShow.fingerprint,
      'show.fingerprint',
      code
    ),
    assets: normalizeAssets(rawShow.assets, code)
  };
}

function normalizeVenueProfile(rawVenue, code) {
  requireExactDataProperties(
    rawVenue,
    ['id', 'revisionId'],
    'venueProfile',
    code
  );
  return {
    id: exactId(rawVenue.id, 'venueProfile.id', code),
    revisionId: exactSha256(
      rawVenue.revisionId,
      'venueProfile.revisionId',
      code
    )
  };
}

function normalizeRouting(rawRouting, show, code) {
  requireDenseArray(
    rawRouting,
    'routing',
    1,
    MAX_SHOW_REHEARSAL_OUTPUTS,
    code
  );
  const assetIds = new Set(show.assets.map(asset => asset.assetId));
  const outputIds = new Set();
  const displayIds = new Set();
  const routing = rawRouting.map((rawRoute, index) => {
    const field = `routing[${index}]`;
    requireExactDataProperties(rawRoute, [
      'outputId',
      'displayId',
      'decision',
      'sourceRoleId',
      'sourceAssetId',
      'renderer',
      'nativeVariant',
      'operatorPreview'
    ], field, code);
    const outputId = exactId(
      rawRoute.outputId,
      `${field}.outputId`,
      code
    );
    if (outputIds.has(outputId)) {
      fail(code, 'routing cannot repeat an output identity.', { outputId });
    }
    outputIds.add(outputId);
    const displayId = exactDisplayId(
      rawRoute.displayId,
      `${field}.displayId`,
      code
    );
    const displayKey = String(displayId);
    if (displayIds.has(displayKey)) {
      fail(code, 'routing cannot repeat a physical display identity.', {
        displayId
      });
    }
    displayIds.add(displayKey);
    if (!DECISION_MODES.has(rawRoute.decision)) {
      fail(code, `${field}.decision is unsupported.`, { field });
    }
    const sourceAssetId = exactId(
      rawRoute.sourceAssetId,
      `${field}.sourceAssetId`,
      code,
      ASSET_ID_PATTERN
    );
    if (!assetIds.has(sourceAssetId)) {
      fail(code, `${field}.sourceAssetId is not part of the exact Show.`, {
        field,
        sourceAssetId
      });
    }
    if (!OUTPUT_RENDERERS.has(rawRoute.renderer)) {
      fail(code, `${field}.renderer is unsupported.`, { field });
    }
    if (
      rawRoute.nativeVariant !== null
      && !NATIVE_VARIANTS.has(rawRoute.nativeVariant)
    ) {
      fail(code, `${field}.nativeVariant is unsupported.`, { field });
    }
    if (typeof rawRoute.operatorPreview !== 'boolean') {
      fail(code, `${field}.operatorPreview must be true or false.`, {
        field
      });
    }

    const nativeShow = show.kind === 'show-package';
    const derived = rawRoute.decision === 'derive-next-text';
    if (
      (nativeShow && rawRoute.renderer !== 'native-cue')
      || (!nativeShow && rawRoute.renderer === 'native-cue')
      || (
        nativeShow
        && rawRoute.nativeVariant !== (
          derived ? 'singer-current-next' : null
        )
      )
      || (
        !nativeShow
        && rawRoute.nativeVariant !== null
      )
      || (
        !nativeShow
        && rawRoute.renderer !== (
          derived ? 'singer-current-next' : 'slides'
        )
      )
    ) {
      fail(
        code,
        `${field} is incompatible with its Show kind and decision.`,
        { field }
      );
    }

    return {
      outputId,
      displayId,
      decision: rawRoute.decision,
      sourceRoleId: exactId(
        rawRoute.sourceRoleId,
        `${field}.sourceRoleId`,
        code
      ),
      sourceAssetId,
      renderer: rawRoute.renderer,
      nativeVariant: rawRoute.nativeVariant,
      operatorPreview: rawRoute.operatorPreview
    };
  });
  return routing.sort((left, right) =>
    compareAscii(left.outputId, right.outputId));
}

function normalizeCueIds(rawCueIds, cueCount, code) {
  requireDenseArray(
    rawCueIds,
    'cueIds',
    1,
    MAX_SHOW_REHEARSAL_CUES,
    code
  );
  if (rawCueIds.length !== cueCount) {
    fail(code, 'cueCount must equal the ordered cueIds length.');
  }
  const seen = new Set();
  return rawCueIds.map((rawCueId, index) => {
    const cueId = exactId(rawCueId, `cueIds[${index}]`, code);
    if (seen.has(cueId)) {
      fail(code, 'cueIds cannot repeat a cue identity.', { cueId });
    }
    seen.add(cueId);
    return cueId;
  });
}

function normalizeEvidence(rawEvidence, code) {
  requireExactDataProperties(
    rawEvidence,
    EVIDENCE_KEYS,
    'Show rehearsal evidence',
    code
  );
  if (
    !Number.isSafeInteger(rawEvidence.cueCount)
    || rawEvidence.cueCount < 1
    || rawEvidence.cueCount > MAX_SHOW_REHEARSAL_CUES
  ) {
    fail(
      code,
      `cueCount must be an integer from 1 to ${MAX_SHOW_REHEARSAL_CUES}.`
    );
  }
  const show = normalizeShow(rawEvidence.show, code);
  const routing = normalizeRouting(rawEvidence.routing, show, code);
  return deepFreeze({
    show,
    venueProfile: normalizeVenueProfile(rawEvidence.venueProfile, code),
    routing,
    cueCount: rawEvidence.cueCount,
    cueIds: normalizeCueIds(
      rawEvidence.cueIds,
      rawEvidence.cueCount,
      code
    )
  });
}

function normalizeShowRehearsalEvidence(rawEvidence) {
  return normalizeEvidence(
    rawEvidence,
    'INVALID_SHOW_REHEARSAL_EVIDENCE'
  );
}

function normalizeAcknowledgements(rawAcknowledgements, evidence, code) {
  requireDenseArray(
    rawAcknowledgements,
    'acknowledgements',
    evidence.cueCount,
    evidence.cueCount,
    code
  );
  const cueOrder = new Map(
    evidence.cueIds.map((cueId, index) => [cueId, index])
  );
  const outputOrder = new Map(
    evidence.routing.map((route, index) => [route.outputId, index])
  );
  const seenCues = new Set();
  const acknowledgements = rawAcknowledgements.map(
    (rawAcknowledgement, index) => {
      const field = `acknowledgements[${index}]`;
      requireExactDataProperties(
        rawAcknowledgement,
        ['cueId', 'outputIds'],
        field,
        code
      );
      const cueId = exactId(
        rawAcknowledgement.cueId,
        `${field}.cueId`,
        code
      );
      if (!cueOrder.has(cueId)) {
        fail(code, `${field} refers to an unknown cue.`, { cueId });
      }
      if (seenCues.has(cueId)) {
        fail(code, 'acknowledgements cannot repeat a cue.', { cueId });
      }
      seenCues.add(cueId);
      requireDenseArray(
        rawAcknowledgement.outputIds,
        `${field}.outputIds`,
        evidence.routing.length,
        evidence.routing.length,
        code
      );
      const seenOutputs = new Set();
      const outputIds = rawAcknowledgement.outputIds.map(
        (rawOutputId, outputIndex) => {
          const outputId = exactId(
            rawOutputId,
            `${field}.outputIds[${outputIndex}]`,
            code
          );
          if (!outputOrder.has(outputId)) {
            fail(code, `${field} refers to an unknown output.`, {
              cueId,
              outputId
            });
          }
          if (seenOutputs.has(outputId)) {
            fail(
              code,
              `${field} repeats an output acknowledgement.`,
              { cueId, outputId }
            );
          }
          seenOutputs.add(outputId);
          return outputId;
        }
      );
      if (seenOutputs.size !== evidence.routing.length) {
        fail(
          code,
          `${field} must acknowledge every active output exactly once.`,
          { cueId }
        );
      }
      outputIds.sort((left, right) =>
        outputOrder.get(left) - outputOrder.get(right));
      return { cueId, outputIds };
    }
  );
  if (seenCues.size !== evidence.cueCount) {
    fail(
      code,
      'acknowledgements must cover every cue exactly once.'
    );
  }
  return acknowledgements.sort((left, right) =>
    cueOrder.get(left.cueId) - cueOrder.get(right.cueId));
}

function normalizeShowRehearsalReceipt(rawReceipt) {
  const code = 'INVALID_SHOW_REHEARSAL_RECEIPT';
  requireExactDataProperties(
    rawReceipt,
    RECEIPT_KEYS,
    'Show rehearsal receipt',
    code
  );
  if (
    rawReceipt.schemaVersion !== SHOW_REHEARSAL_RECEIPT_SCHEMA_VERSION
    || rawReceipt.kind !== SHOW_REHEARSAL_RECEIPT_KIND
  ) {
    fail(
      code,
      `Show rehearsal receipt must be a ${SHOW_REHEARSAL_RECEIPT_KIND} schema v${SHOW_REHEARSAL_RECEIPT_SCHEMA_VERSION} document.`
    );
  }
  const evidence = normalizeEvidence({
    show: rawReceipt.show,
    venueProfile: rawReceipt.venueProfile,
    routing: rawReceipt.routing,
    cueCount: rawReceipt.cueCount,
    cueIds: rawReceipt.cueIds
  }, code);
  return deepFreeze({
    schemaVersion: SHOW_REHEARSAL_RECEIPT_SCHEMA_VERSION,
    kind: SHOW_REHEARSAL_RECEIPT_KIND,
    ...evidence,
    acknowledgements: normalizeAcknowledgements(
      rawReceipt.acknowledgements,
      evidence,
      code
    )
  });
}

function stableObject(value) {
  if (Array.isArray(value)) return value.map(stableObject);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map(key => [key, stableObject(value[key])])
  );
}

function serializeShowRehearsalReceipt(rawReceipt) {
  const receipt = normalizeShowRehearsalReceipt(rawReceipt);
  const source = `${JSON.stringify(stableObject(receipt), null, 2)}\n`;
  if (Buffer.byteLength(source, 'utf8') > MAX_SHOW_REHEARSAL_RECEIPT_BYTES) {
    fail(
      'SHOW_REHEARSAL_RECEIPT_TOO_LARGE',
      `Show rehearsal receipt may be at most ${MAX_SHOW_REHEARSAL_RECEIPT_BYTES} bytes.`
    );
  }
  return source;
}

function parseShowRehearsalReceipt(source) {
  if (typeof source !== 'string') {
    fail(
      'INVALID_SHOW_REHEARSAL_RECEIPT',
      'Show rehearsal receipt source must be text.'
    );
  }
  if (
    Buffer.byteLength(source, 'utf8')
      > MAX_SHOW_REHEARSAL_RECEIPT_BYTES
  ) {
    fail(
      'SHOW_REHEARSAL_RECEIPT_TOO_LARGE',
      `Show rehearsal receipt source must be text no larger than ${MAX_SHOW_REHEARSAL_RECEIPT_BYTES} bytes.`
    );
  }
  let rawReceipt;
  try {
    rawReceipt = JSON.parse(source);
  } catch (error) {
    fail(
      'INVALID_SHOW_REHEARSAL_RECEIPT',
      'Show rehearsal receipt source is not valid JSON.',
      { cause: error.message }
    );
  }
  const receipt = normalizeShowRehearsalReceipt(rawReceipt);
  if (serializeShowRehearsalReceipt(receipt) !== source) {
    fail(
      'SHOW_REHEARSAL_RECEIPT_NONCANONICAL',
      'Show rehearsal receipt source is not in exact canonical form.'
    );
  }
  return receipt;
}

function evidenceFromReceipt(receipt) {
  return {
    show: receipt.show,
    venueProfile: receipt.venueProfile,
    routing: receipt.routing,
    cueCount: receipt.cueCount,
    cueIds: receipt.cueIds
  };
}

function canonicalValue(value) {
  return JSON.stringify(stableObject(value));
}

function assertShowRehearsalReceiptMatches(
  rawReceipt,
  rawCurrentEvidence
) {
  const receipt = normalizeShowRehearsalReceipt(rawReceipt);
  let currentEvidence;
  try {
    currentEvidence = normalizeShowRehearsalEvidence(
      rawCurrentEvidence
    );
  } catch (error) {
    if (error instanceof ShowRehearsalReceiptError) {
      fail(
        'SHOW_REHEARSAL_RECEIPT_MISMATCH',
        'The current Show evidence is invalid and cannot match the rehearsal receipt.',
        { causeCode: error.code }
      );
    }
    throw error;
  }
  if (
    canonicalValue(evidenceFromReceipt(receipt))
      !== canonicalValue(currentEvidence)
  ) {
    fail(
      'SHOW_REHEARSAL_RECEIPT_MISMATCH',
      'The rehearsal receipt does not match the exact current Show, venue, routing, or cue order.'
    );
  }
  return receipt;
}

function showRehearsalReceiptMatches(rawReceipt, rawCurrentEvidence) {
  try {
    assertShowRehearsalReceiptMatches(rawReceipt, rawCurrentEvidence);
    return true;
  } catch (_error) {
    return false;
  }
}

module.exports = {
  MAX_SHOW_REHEARSAL_ASSETS,
  MAX_SHOW_REHEARSAL_CUES,
  MAX_SHOW_REHEARSAL_OUTPUTS,
  MAX_SHOW_REHEARSAL_RECEIPT_BYTES,
  SHOW_REHEARSAL_RECEIPT_KIND,
  SHOW_REHEARSAL_RECEIPT_SCHEMA_VERSION,
  ShowRehearsalReceiptError,
  assertShowRehearsalReceiptMatches,
  normalizeShowRehearsalEvidence,
  normalizeShowRehearsalReceipt,
  parseShowRehearsalReceipt,
  serializeShowRehearsalReceipt,
  showRehearsalReceiptMatches
};
