'use strict';

const CURRENT_PROFILE_SCHEMA_VERSION = 1;

const INPUT_KINDS = Object.freeze(['deck', 'native-cue']);
const INPUT_REQUIREMENTS = Object.freeze([
  'always',
  'if-used-by-enabled-output',
  'optional'
]);
const DATE_POLICIES = Object.freeze(['service-date', 'warn-if-stale', 'none']);
const SERVICE_DATE_ORDERS = Object.freeze(['mdy', 'dmy']);
const OUTPUT_KINDS = Object.freeze(['normal', 'singer']);
const OUTPUT_MODES = Object.freeze([
  'role',
  'mirror',
  'derive-next-text',
  'native-cue',
  'disabled'
]);
const OUTPUT_RENDERERS = Object.freeze([
  'slides',
  'singer-current-next',
  'native-cue'
]);
const STALENESS_POLICIES = Object.freeze([
  'warn-and-confirm',
  'warn',
  'block',
  'ignore'
]);

// These are the same limits enforced by ServiceSetResolver at scan time. Keep
// them at the persisted-profile boundary too so an administrator cannot save a
// configuration that will only fail later, when a volunteer opens Load.
const MAX_FILENAME_MATCHERS_PER_ROLE = 32;
const MAX_FILENAME_MATCHER_LENGTH = 128;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

class VenueProfileError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'VenueProfileError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new VenueProfileError(code, message, details);
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function firstDefined(...values) {
  return values.find(value => value !== undefined);
}

function trimString(value, fallback, field) {
  const candidate = value === undefined || value === null ? fallback : value;
  if (typeof candidate !== 'string' || candidate.trim().length === 0) {
    fail('INVALID_STRING', `${field} must be a non-empty string.`, { field });
  }
  return candidate.trim();
}

function optionalString(value, field) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') {
    fail('INVALID_STRING', `${field} must be a string or null.`, { field });
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function optionalTimeZone(value, field) {
  const timeZone = optionalString(value, field);
  if (timeZone === null) return null;
  try {
    // Constructing the formatter is the portable validation contract used by
    // both Electron and the renderer. It rejects misspelled IANA zone names
    // before a volunteer discovers the problem on service day.
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date(0));
  } catch (error) {
    fail('INVALID_TIME_ZONE', `${field} must be a valid IANA time zone.`, {
      field,
      timeZone
    });
  }
  return timeZone;
}

function normalizeId(value, fallback, field) {
  const id = trimString(value, fallback, field);
  if (!ID_PATTERN.test(id)) {
    fail(
      'INVALID_ID',
      `${field} must start with a letter or number and use only letters, numbers, dot, underscore, colon, or hyphen.`,
      { field, id }
    );
  }
  return id;
}

function booleanOr(value, fallback, field) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') {
    fail('INVALID_BOOLEAN', `${field} must be true or false.`, { field });
  }
  return value;
}

function enumOr(value, fallback, allowed, field) {
  const candidate = value === undefined || value === null ? fallback : value;
  if (!allowed.includes(candidate)) {
    fail('INVALID_ENUM', `${field} has an unsupported value.`, {
      field,
      value: candidate,
      allowed
    });
  }
  return candidate;
}

function numberInRange(value, fallback, minimum, maximum, field) {
  const candidate = value === undefined || value === null || value === ''
    ? fallback
    : Number(value);
  if (!Number.isFinite(candidate)) {
    fail('INVALID_NUMBER', `${field} must be a finite number.`, { field });
  }
  return Math.max(minimum, Math.min(maximum, candidate));
}

function uniqueStrings(value, fallback, field, { lowerCase = false, stripDot = false } = {}) {
  const candidate = value === undefined ? fallback : value;
  if (!Array.isArray(candidate)) {
    fail('INVALID_STRING_LIST', `${field} must be an array of strings.`, { field });
  }

  const result = [];
  const seen = new Set();
  for (const item of candidate) {
    if (typeof item !== 'string' || item.trim().length === 0) {
      fail('INVALID_STRING_LIST', `${field} must contain only non-empty strings.`, { field });
    }
    let normalized = item.trim();
    if (stripDot) normalized = normalized.replace(/^\.+/, '');
    if (lowerCase) normalized = normalized.toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function hasSearchableFilenameMatcherText(value) {
  return /[\p{L}\p{M}\p{N}]/u.test(value);
}

function normalizeFilenameMatchers(value, field) {
  const candidate = value === undefined ? [] : value;
  if (!Array.isArray(candidate)) {
    fail('INVALID_FILENAME_MATCHERS', `${field} must be an array of strings.`, { field });
  }
  if (candidate.length > MAX_FILENAME_MATCHERS_PER_ROLE) {
    fail(
      'TOO_MANY_FILENAME_MATCHERS',
      `${field} can contain at most ${MAX_FILENAME_MATCHERS_PER_ROLE} matchers.`,
      { field, maximum: MAX_FILENAME_MATCHERS_PER_ROLE }
    );
  }

  const result = uniqueStrings(candidate, [], field);
  for (const matcher of result) {
    if (matcher.length > MAX_FILENAME_MATCHER_LENGTH
      || !hasSearchableFilenameMatcherText(matcher)) {
      fail(
        'INVALID_FILENAME_MATCHER',
        `${field} entries must contain a letter or number and be at most ${MAX_FILENAME_MATCHER_LENGTH} characters.`,
        { field, maximumLength: MAX_FILENAME_MATCHER_LENGTH }
      );
    }
  }
  return result;
}

function validateFilenameMatchers(value, field) {
  if (!Array.isArray(value) || value.length > MAX_FILENAME_MATCHERS_PER_ROLE) {
    fail(
      'INVALID_FILENAME_MATCHERS',
      `${field} must be an array with at most ${MAX_FILENAME_MATCHERS_PER_ROLE} entries.`,
      { field, maximum: MAX_FILENAME_MATCHERS_PER_ROLE }
    );
  }
  for (const matcher of value) {
    if (typeof matcher !== 'string'
      || matcher.length === 0
      || matcher.length > MAX_FILENAME_MATCHER_LENGTH
      || !hasSearchableFilenameMatcherText(matcher)) {
      fail(
        'INVALID_FILENAME_MATCHER',
        `${field} entries must contain a letter or number and be at most ${MAX_FILENAME_MATCHER_LENGTH} characters.`,
        { field, maximumLength: MAX_FILENAME_MATCHER_LENGTH }
      );
    }
  }
}

function normalizeLegacyDisplayId(value, field) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      fail('INVALID_DISPLAY_ID', `${field} must be a finite number, string, or null.`, { field });
    }
    return value;
  }
  if (typeof value !== 'string') {
    fail('INVALID_DISPLAY_ID', `${field} must be a finite number, string, or null.`, { field });
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function normalizeInputRoles(rawRoles) {
  if (!Array.isArray(rawRoles)) {
    fail('INVALID_INPUT_ROLES', 'inputRoles must be an array.');
  }

  const ids = new Set();
  return rawRoles.map((rawRole, index) => {
    if (!isRecord(rawRole)) {
      fail('INVALID_INPUT_ROLE', `Input role ${index + 1} must be an object.`, { index });
    }

    const id = normalizeId(rawRole.id, `input-${index + 1}`, `inputRoles[${index}].id`);
    if (ids.has(id)) {
      fail('DUPLICATE_INPUT_ROLE_ID', `Input role ID "${id}" is used more than once.`, {
        roleId: id,
        index
      });
    }
    ids.add(id);

    const kind = enumOr(
      rawRole.kind,
      'deck',
      INPUT_KINDS,
      `inputRoles[${index}].kind`
    );
    const defaultAcceptedTypes = kind === 'deck'
      ? ['pptx', 'ppt', 'service-project']
      : ['service-project'];

    return {
      id,
      label: trimString(
        firstDefined(rawRole.label, rawRole.name),
        `Input ${index + 1}`,
        `inputRoles[${index}].label`
      ),
      enabled: booleanOr(rawRole.enabled, true, `inputRoles[${index}].enabled`),
      kind,
      acceptedTypes: uniqueStrings(
        rawRole.acceptedTypes,
        defaultAcceptedTypes,
        `inputRoles[${index}].acceptedTypes`,
        { lowerCase: true, stripDot: true }
      ),
      required: enumOr(
        rawRole.required,
        'if-used-by-enabled-output',
        INPUT_REQUIREMENTS,
        `inputRoles[${index}].required`
      ),
      filenameMatchers: normalizeFilenameMatchers(
        rawRole.filenameMatchers,
        `inputRoles[${index}].filenameMatchers`
      ),
      datePolicy: enumOr(
        rawRole.datePolicy,
        'service-date',
        DATE_POLICIES,
        `inputRoles[${index}].datePolicy`
      )
    };
  });
}

function inferOutputMode(rawOutput) {
  const source = isRecord(rawOutput.source) ? rawOutput.source : {};
  const renderer = firstDefined(rawOutput.renderer, rawOutput.rendererPresetId);
  if (rawOutput.enabled === false && firstDefined(rawOutput.mode, source.mode) === undefined) {
    return 'role';
  }
  if (renderer === 'singer-current-next') return 'derive-next-text';
  if (renderer === 'native-cue') return 'native-cue';
  return 'role';
}

function defaultRendererForMode(mode) {
  if (mode === 'derive-next-text') return 'singer-current-next';
  if (mode === 'native-cue') return 'native-cue';
  return 'slides';
}

function normalizeFallback(rawFallback, index) {
  if (rawFallback === undefined || rawFallback === null) return null;
  if (!isRecord(rawFallback)) {
    fail('INVALID_OUTPUT_FALLBACK', `outputs[${index}].fallback must be an object or null.`, {
      index
    });
  }

  const mode = enumOr(
    rawFallback.mode,
    'derive-next-text',
    OUTPUT_MODES,
    `outputs[${index}].fallback.mode`
  );
  return {
    mode,
    sourceRoleId: optionalString(
      firstDefined(rawFallback.sourceRoleId, rawFallback.roleId),
      `outputs[${index}].fallback.sourceRoleId`
    ),
    sourceOutputId: optionalString(
      firstDefined(rawFallback.sourceOutputId, rawFallback.outputId),
      `outputs[${index}].fallback.sourceOutputId`
    ),
    renderer: enumOr(
      rawFallback.renderer,
      defaultRendererForMode(mode),
      OUTPUT_RENDERERS,
      `outputs[${index}].fallback.renderer`
    )
  };
}

function normalizeOutputs(rawOutputs, inputRoles, rawPreviewOutputIds) {
  if (!Array.isArray(rawOutputs)) {
    fail('INVALID_OUTPUTS', 'outputs must be an array.');
  }

  const previewIds = rawPreviewOutputIds === undefined
    ? new Set()
    : new Set(uniqueStrings(rawPreviewOutputIds, [], 'previewOutputIds'));
  const ids = new Set();
  const firstRoleId = inputRoles[0]?.id || null;

  return rawOutputs.map((rawOutput, index) => {
    if (!isRecord(rawOutput)) {
      fail('INVALID_OUTPUT', `Output ${index + 1} must be an object.`, { index });
    }

    const id = normalizeId(rawOutput.id, `output-${index + 1}`, `outputs[${index}].id`);
    if (ids.has(id)) {
      fail('DUPLICATE_OUTPUT_ID', `Output ID "${id}" is used more than once.`, {
        outputId: id,
        index
      });
    }
    ids.add(id);

    const source = isRecord(rawOutput.source) ? rawOutput.source : {};
    const mode = enumOr(
      firstDefined(rawOutput.mode, source.mode),
      inferOutputMode(rawOutput),
      OUTPUT_MODES,
      `outputs[${index}].mode`
    );
    const expectedRoleId = optionalString(
      firstDefined(
        rawOutput.expectedRoleId,
        rawOutput.expectedRole,
        mode === 'role' ? rawOutput.sourceRoleId : undefined,
        mode === 'role' ? source.roleId : undefined,
        firstRoleId
      ),
      `outputs[${index}].expectedRoleId`
    );
    const sourceRoleId = optionalString(
      firstDefined(
        rawOutput.sourceRoleId,
        source.roleId,
        mode === 'role' ? expectedRoleId : undefined
      ),
      `outputs[${index}].sourceRoleId`
    );
    const sourceOutputId = optionalString(
      firstDefined(rawOutput.sourceOutputId, source.outputId),
      `outputs[${index}].sourceOutputId`
    );
    const renderer = enumOr(
      firstDefined(rawOutput.renderer, rawOutput.rendererPresetId),
      defaultRendererForMode(mode),
      OUTPUT_RENDERERS,
      `outputs[${index}].renderer`
    );
    const explicitPreview = firstDefined(rawOutput.operatorPreview, rawOutput.previewEnabled);
    const enabled = booleanOr(
      rawOutput.enabled,
      mode !== 'disabled',
      `outputs[${index}].enabled`
    );

    return {
      id,
      name: trimString(
        firstDefined(rawOutput.name, rawOutput.label),
        `Output ${index + 1}`,
        `outputs[${index}].name`
      ),
      enabled: mode === 'disabled' ? false : enabled,
      kind: enumOr(
        rawOutput.kind,
        renderer === 'singer-current-next' || id === 'singer' ? 'singer' : 'normal',
        OUTPUT_KINDS,
        `outputs[${index}].kind`
      ),
      expectedRoleId,
      mode,
      renderer,
      sourceRoleId,
      sourceOutputId,
      displayFingerprint: optionalString(
        firstDefined(rawOutput.displayFingerprint, rawOutput.display?.fingerprint),
        `outputs[${index}].displayFingerprint`
      ),
      legacyDisplayId: normalizeLegacyDisplayId(
        firstDefined(
          rawOutput.legacyDisplayId,
          rawOutput.display?.legacyId,
          rawOutput.displayId
        ),
        `outputs[${index}].legacyDisplayId`
      ),
      operatorPreview: booleanOr(
        explicitPreview,
        previewIds.has(id),
        `outputs[${index}].operatorPreview`
      ),
      fallback: normalizeFallback(
        firstDefined(
          rawOutput.fallback,
          rawOutput.fallbackMode === undefined && rawOutput.fallbackSourceRoleId === undefined
            ? undefined
            : {
                mode: rawOutput.fallbackMode,
                sourceRoleId: rawOutput.fallbackSourceRoleId,
                sourceOutputId: rawOutput.fallbackSourceOutputId
              }
        ),
        index
      )
    };
  });
}

function defaultInputRoles() {
  return [
    {
      id: 'russian',
      label: 'Russian',
      kind: 'deck',
      filenameMatchers: ['rus', 'russian', 'рус', 'служение']
    },
    {
      id: 'english',
      label: 'English',
      kind: 'deck',
      filenameMatchers: ['eng', 'english', 'service']
    },
    {
      id: 'media',
      label: 'Singers Screen (Media)',
      kind: 'deck',
      filenameMatchers: ['media', 'singer', 'stage']
    }
  ];
}

function upgradeKnownDefaultMatchers(inputRoles) {
  const upgrades = {
    russian: {
      previous: ['rus', 'russian', 'рус'],
      added: 'служение'
    },
    english: {
      previous: ['eng', 'english'],
      added: 'service'
    }
  };
  return inputRoles.map(role => {
    const upgrade = upgrades[role.id];
    if (!upgrade
      || role.kind !== 'deck'
      || role.filenameMatchers.length !== upgrade.previous.length
      || !role.filenameMatchers.every((matcher, index) => matcher === upgrade.previous[index])) {
      return role;
    }
    return {
      ...role,
      filenameMatchers: [...role.filenameMatchers, upgrade.added]
    };
  });
}

function getLegacyDisplay(settings, roleId) {
  const assignments = isRecord(settings.displayAssignments) ? settings.displayAssignments : {};
  const capitalized = `${roleId[0].toUpperCase()}${roleId.slice(1)}`;
  return firstDefined(
    assignments[roleId],
    settings[`${roleId}Display`],
    settings[`${roleId}DisplayId`],
    settings[`display${capitalized}`]
  );
}

function hasOwn(record, key) {
  return isRecord(record) && Object.prototype.hasOwnProperty.call(record, key);
}

function getLegacyOutputEnabled(settings, roleId) {
  const assignments = isRecord(settings.displayAssignments) ? settings.displayAssignments : {};
  const capitalized = `${roleId[0].toUpperCase()}${roleId.slice(1)}`;
  const keys = [`${roleId}Display`, `${roleId}DisplayId`, `display${capitalized}`];
  const hasAssignment = hasOwn(assignments, roleId) || keys.some(key => hasOwn(settings, key));
  if (hasAssignment) {
    const value = getLegacyDisplay(settings, roleId);
    return value !== null && value !== undefined && value !== '';
  }
  // Match the legacy first-run intent: the two auditorium channels are part of
  // the default venue, while the optional Singer output is opt-in until a
  // physical screen is deliberately assigned.
  return roleId !== 'singer';
}

function getLegacyFingerprint(settings, outputId) {
  const fingerprints = isRecord(settings.displayFingerprints) ? settings.displayFingerprints : {};
  return firstDefined(
    fingerprints[outputId],
    settings[`${outputId}DisplayFingerprint`]
  );
}

function getLegacyPreview(settings, outputId, defaultValue) {
  const previewEnabled = settings.previewEnabled;
  const suffix = outputId === 'russian'
    ? 'Russian'
    : outputId === 'english'
      ? 'English'
      : 'Singer';
  const specific = settings[`showPreview${suffix}`];
  if (typeof specific === 'boolean') return specific;
  if (isRecord(previewEnabled) && typeof previewEnabled[outputId] === 'boolean') {
    return previewEnabled[outputId];
  }
  if (typeof previewEnabled === 'boolean') {
    return previewEnabled ? defaultValue : false;
  }
  return defaultValue;
}

function defaultOutputs(settings, singerSourceRoleId) {
  const outputNames = isRecord(settings.outputNames) ? settings.outputNames : {};
  return [
    {
      id: 'russian',
      name: outputNames.russian || 'Russian Screen',
      enabled: getLegacyOutputEnabled(settings, 'russian'),
      kind: 'normal',
      expectedRoleId: 'russian',
      mode: 'role',
      renderer: 'slides',
      sourceRoleId: 'russian',
      displayFingerprint: getLegacyFingerprint(settings, 'russian'),
      legacyDisplayId: getLegacyDisplay(settings, 'russian'),
      operatorPreview: getLegacyPreview(settings, 'russian', false)
    },
    {
      id: 'english',
      name: outputNames.english || 'English Screen',
      enabled: getLegacyOutputEnabled(settings, 'english'),
      kind: 'normal',
      expectedRoleId: 'english',
      mode: 'role',
      renderer: 'slides',
      sourceRoleId: 'english',
      displayFingerprint: getLegacyFingerprint(settings, 'english'),
      legacyDisplayId: getLegacyDisplay(settings, 'english'),
      operatorPreview: getLegacyPreview(settings, 'english', false)
    },
    {
      id: 'singer',
      name: outputNames.singer || 'Singers Screen',
      enabled: getLegacyOutputEnabled(settings, 'singer'),
      kind: 'singer',
      expectedRoleId: 'media',
      mode: 'role',
      renderer: 'slides',
      sourceRoleId: 'media',
      displayFingerprint: getLegacyFingerprint(settings, 'singer'),
      legacyDisplayId: getLegacyDisplay(settings, 'singer'),
      operatorPreview: getLegacyPreview(settings, 'singer', true),
      fallback: {
        mode: 'derive-next-text',
        sourceRoleId: singerSourceRoleId,
        renderer: 'singer-current-next'
      }
    }
  ];
}

function normalizePreferences(rawProfile, inputRoleIds) {
  const transition = isRecord(rawProfile.transition) ? rawProfile.transition : {};
  const singer = isRecord(rawProfile.singer) ? rawProfile.singer : {};
  const operator = isRecord(rawProfile.operator) ? rawProfile.operator : {};
  const requestedSingerSource = optionalString(
    firstDefined(
      singer.fallbackSourceRoleId,
      rawProfile.singerSourceRoleId,
      rawProfile.singerSource,
      rawProfile.singerLanguage
    ),
    'singer.fallbackSourceRoleId'
  );
  const singerSourceRoleId = inputRoleIds.has(requestedSingerSource)
    ? requestedSingerSource
    : (inputRoleIds.has('russian') ? 'russian' : [...inputRoleIds][0] || null);

  return {
    transition: {
      fadeDurationMs: numberInRange(
        firstDefined(transition.fadeDurationMs, rawProfile.fadeDuration),
        300,
        0,
        5000,
        'transition.fadeDurationMs'
      ),
      syncMode: booleanOr(
        firstDefined(transition.syncMode, rawProfile.syncMode),
        false,
        'transition.syncMode'
      )
    },
    singer: {
      fallbackSourceRoleId: singerSourceRoleId,
      fontSizePx: numberInRange(
        firstDefined(singer.fontSizePx, rawProfile.singerFontSize),
        36,
        12,
        240,
        'singer.fontSizePx'
      ),
      charLimit: numberInRange(
        firstDefined(singer.charLimit, rawProfile.singerCharLimit),
        70,
        10,
        500,
        'singer.charLimit'
      ),
      textPaddingPx: numberInRange(
        firstDefined(singer.textPaddingPx, rawProfile.singerTextPadding),
        4,
        0,
        80,
        'singer.textPaddingPx'
      )
    },
    operator: {
      advancedWarningAcknowledged: booleanOr(
        firstDefined(operator.advancedWarningAcknowledged, rawProfile.advancedWarningAcknowledged),
        false,
        'operator.advancedWarningAcknowledged'
      ),
      thumbnailZoomPercent: numberInRange(
        firstDefined(operator.thumbnailZoomPercent, rawProfile.thumbnailZoom),
        100,
        50,
        200,
        'operator.thumbnailZoomPercent'
      ),
      previewOpenOutputIds: uniqueStrings(
        firstDefined(operator.previewOpenOutputIds, rawProfile.previewOpenOutputIds),
        [],
        'operator.previewOpenOutputIds'
      )
    }
  };
}

function assertKnownSchemaVersion(value) {
  if (!Number.isInteger(value) || value < 0) {
    fail('INVALID_SCHEMA_VERSION', 'schemaVersion must be a non-negative integer.', {
      schemaVersion: value
    });
  }
  if (value > CURRENT_PROFILE_SCHEMA_VERSION) {
    fail(
      'UNSUPPORTED_SCHEMA_VERSION',
      `This profile uses schema version ${value}, but this SyncShow build supports up to version ${CURRENT_PROFILE_SCHEMA_VERSION}.`,
      { schemaVersion: value, supportedVersion: CURRENT_PROFILE_SCHEMA_VERSION }
    );
  }
}

/**
 * Normalize an unversioned/v1 profile into the canonical mutable v1 shape.
 * Explicit array order is preserved; labels may change without changing IDs.
 */
function normalizeVenueProfile(rawProfile, options = {}) {
  if (!isRecord(rawProfile)) {
    fail('INVALID_PROFILE', 'Venue profile must be an object.');
  }
  if (!isRecord(options)) {
    fail('INVALID_OPTIONS', 'Venue profile options must be an object.');
  }

  if (rawProfile.schemaVersion !== undefined) {
    assertKnownSchemaVersion(rawProfile.schemaVersion);
  }

  const rawInputRoles = rawProfile.inputRoles === undefined
    ? defaultInputRoles()
    : rawProfile.inputRoles;
  const inputRoles = upgradeKnownDefaultMatchers(normalizeInputRoles(rawInputRoles));
  const inputRoleIds = new Set(inputRoles.map(role => role.id));
  const preferences = normalizePreferences(rawProfile, inputRoleIds);
  const rawOutputs = rawProfile.outputs === undefined
    ? defaultOutputs(rawProfile, preferences.singer.fallbackSourceRoleId)
    : rawProfile.outputs;
  const outputs = normalizeOutputs(rawOutputs, inputRoles, rawProfile.previewOutputIds);
  const localServiceFolder = optionalString(rawProfile.localServiceFolder, 'localServiceFolder');
  const rawDriveConnectionId = optionalString(rawProfile.driveConnectionId, 'driveConnectionId');
  const driveConnectionId = rawDriveConnectionId === null
    ? null
    : normalizeId(rawDriveConnectionId, undefined, 'driveConnectionId');
  if (localServiceFolder !== null && driveConnectionId !== null) {
    fail(
      'MULTIPLE_SERVICE_SOURCES',
      'Choose either a local service folder or a Google Drive connection, not both.'
    );
  }

  const profile = {
    schemaVersion: CURRENT_PROFILE_SCHEMA_VERSION,
    id: normalizeId(
      firstDefined(rawProfile.id, options.profileId),
      'default',
      'id'
    ),
    name: trimString(
      firstDefined(rawProfile.name, options.profileName),
      'Main Sanctuary',
      'name'
    ),
    timeZone: optionalTimeZone(
      firstDefined(rawProfile.timeZone, options.timeZone),
      'timeZone'
    ),
    serviceDateOrder: enumOr(
      firstDefined(rawProfile.serviceDateOrder, rawProfile.dateOrder),
      'mdy',
      SERVICE_DATE_ORDERS,
      'serviceDateOrder'
    ),
    friendlyModeDefault: booleanOr(
      firstDefined(rawProfile.friendlyModeDefault, rawProfile.friendlyMode),
      true,
      'friendlyModeDefault'
    ),
    stalenessPolicy: enumOr(
      rawProfile.stalenessPolicy,
      'warn-and-confirm',
      STALENESS_POLICIES,
      'stalenessPolicy'
    ),
    localServiceFolder,
    driveConnectionId,
    inputRoles,
    outputs,
    previewOutputIds: outputs.filter(output => output.operatorPreview).map(output => output.id),
    transition: preferences.transition,
    singer: preferences.singer,
    operator: preferences.operator
  };

  validateVenueProfile(profile);
  return profile;
}

function validateRoute(route, context, roleIds, outputIds) {
  if (!OUTPUT_MODES.includes(route.mode)) {
    fail('INVALID_OUTPUT_MODE', `${context}.mode is unsupported.`, { context, mode: route.mode });
  }
  if (!OUTPUT_RENDERERS.includes(route.renderer)) {
    fail('INVALID_OUTPUT_RENDERER', `${context}.renderer is unsupported.`, {
      context,
      renderer: route.renderer
    });
  }
  if (route.sourceRoleId !== null && !roleIds.has(route.sourceRoleId)) {
    fail('UNKNOWN_SOURCE_ROLE', `${context} refers to an input role that does not exist.`, {
      context,
      roleId: route.sourceRoleId
    });
  }
  if (route.sourceOutputId !== null && !outputIds.has(route.sourceOutputId)) {
    fail('UNKNOWN_SOURCE_OUTPUT', `${context} refers to an output that does not exist.`, {
      context,
      outputId: route.sourceOutputId
    });
  }
  if (route.mode === 'role' && route.sourceRoleId === null) {
    fail('MISSING_SOURCE_ROLE', `${context} needs a source input role.`, { context });
  }
  if (route.mode === 'derive-next-text') {
    if (route.sourceRoleId === null) {
      fail('MISSING_SOURCE_ROLE', `${context} needs a source input role.`, { context });
    }
    if (route.renderer !== 'singer-current-next') {
      fail('INVALID_DERIVED_RENDERER', `${context} must use the Singer current/next renderer.`, {
        context,
        renderer: route.renderer
      });
    }
  }
  if (route.mode === 'native-cue' && route.renderer !== 'native-cue') {
    fail('INVALID_NATIVE_RENDERER', `${context} must use the native-cue renderer.`, {
      context,
      renderer: route.renderer
    });
  }
  if (route.mode === 'mirror' && route.sourceRoleId === null && route.sourceOutputId === null) {
    fail('MISSING_MIRROR_SOURCE', `${context} needs a source role or output.`, { context });
  }
}

function validateMirrorCycles(outputs) {
  const byId = new Map(outputs.map(output => [output.id, output]));
  for (const output of outputs) {
    const visited = new Set([output.id]);
    let current = output;
    while (current.mode === 'mirror' && current.sourceOutputId) {
      if (visited.has(current.sourceOutputId)) {
        fail('MIRROR_CYCLE', `Output "${output.name}" is part of a mirror cycle.`, {
          outputId: output.id,
          cycleAt: current.sourceOutputId
        });
      }
      visited.add(current.sourceOutputId);
      current = byId.get(current.sourceOutputId);
      if (!current) break;
    }
  }
}

/** Validate a canonical venue-profile record. Returns true or throws. */
function validateVenueProfile(profile) {
  if (!isRecord(profile)) fail('INVALID_PROFILE', 'Venue profile must be an object.');
  assertKnownSchemaVersion(profile.schemaVersion);
  if (profile.schemaVersion !== CURRENT_PROFILE_SCHEMA_VERSION) {
    fail('PROFILE_NOT_MIGRATED', 'Venue profile must be migrated before validation.', {
      schemaVersion: profile.schemaVersion
    });
  }
  normalizeId(profile.id, undefined, 'id');
  trimString(profile.name, undefined, 'name');
  if (profile.timeZone !== null && typeof profile.timeZone !== 'string') {
    fail('INVALID_TIME_ZONE', 'timeZone must be a string or null.');
  }
  if (!SERVICE_DATE_ORDERS.includes(profile.serviceDateOrder)) {
    fail('INVALID_SERVICE_DATE_ORDER', 'serviceDateOrder is unsupported.');
  }
  if (typeof profile.friendlyModeDefault !== 'boolean') {
    fail('INVALID_FRIENDLY_MODE', 'friendlyModeDefault must be true or false.');
  }
  if (!STALENESS_POLICIES.includes(profile.stalenessPolicy)) {
    fail('INVALID_STALENESS_POLICY', 'stalenessPolicy is unsupported.');
  }
  if (profile.localServiceFolder !== null && typeof profile.localServiceFolder !== 'string') {
    fail('INVALID_SERVICE_SOURCE', 'localServiceFolder must be a string or null.');
  }
  if (profile.driveConnectionId !== null) {
    normalizeId(profile.driveConnectionId, undefined, 'driveConnectionId');
  }
  if (profile.localServiceFolder !== null && profile.driveConnectionId !== null) {
    fail(
      'MULTIPLE_SERVICE_SOURCES',
      'Choose either a local service folder or a Google Drive connection, not both.'
    );
  }
  if (!Array.isArray(profile.inputRoles) || profile.inputRoles.length === 0) {
    fail('NO_INPUT_ROLES', 'A venue profile needs at least one input role.');
  }
  if (!Array.isArray(profile.outputs) || profile.outputs.length === 0) {
    fail('NO_OUTPUTS', 'A venue profile needs at least one output.');
  }

  const roleIds = new Set();
  const enabledRoleIds = new Set();
  for (const [index, role] of profile.inputRoles.entries()) {
    if (!isRecord(role)) fail('INVALID_INPUT_ROLE', `Input role ${index + 1} must be an object.`);
    normalizeId(role.id, undefined, `inputRoles[${index}].id`);
    if (roleIds.has(role.id)) {
      fail('DUPLICATE_INPUT_ROLE_ID', `Input role ID "${role.id}" is used more than once.`, {
        roleId: role.id
      });
    }
    roleIds.add(role.id);
    trimString(role.label, undefined, `inputRoles[${index}].label`);
    if (typeof role.enabled !== 'boolean') fail('INVALID_INPUT_ROLE_ENABLED', 'Input role enabled state is invalid.');
    if (role.enabled) enabledRoleIds.add(role.id);
    if (!INPUT_KINDS.includes(role.kind)) fail('INVALID_INPUT_KIND', 'Input role kind is unsupported.');
    if (!Array.isArray(role.acceptedTypes)) fail('INVALID_ACCEPTED_TYPES', 'acceptedTypes must be an array.');
    if (!INPUT_REQUIREMENTS.includes(role.required)) fail('INVALID_INPUT_REQUIREMENT', 'Input requirement is unsupported.');
    validateFilenameMatchers(role.filenameMatchers, `inputRoles[${index}].filenameMatchers`);
    if (!DATE_POLICIES.includes(role.datePolicy)) fail('INVALID_DATE_POLICY', 'Input date policy is unsupported.');
  }

  const outputIds = new Set();
  for (const [index, output] of profile.outputs.entries()) {
    if (!isRecord(output)) fail('INVALID_OUTPUT', `Output ${index + 1} must be an object.`);
    normalizeId(output.id, undefined, `outputs[${index}].id`);
    if (outputIds.has(output.id)) {
      fail('DUPLICATE_OUTPUT_ID', `Output ID "${output.id}" is used more than once.`, {
        outputId: output.id
      });
    }
    outputIds.add(output.id);
  }

  for (const [index, output] of profile.outputs.entries()) {
    const context = `outputs[${index}]`;
    trimString(output.name, undefined, `${context}.name`);
    if (typeof output.enabled !== 'boolean') fail('INVALID_OUTPUT_ENABLED', `${context}.enabled is invalid.`);
    if (!OUTPUT_KINDS.includes(output.kind)) fail('INVALID_OUTPUT_KIND', `${context}.kind is unsupported.`);
    if (output.expectedRoleId !== null && !roleIds.has(output.expectedRoleId)) {
      fail('UNKNOWN_EXPECTED_ROLE', `${context} expects an input role that does not exist.`, {
        outputId: output.id,
        roleId: output.expectedRoleId
      });
    }
    if ((output.mode === 'role' || output.mode === 'derive-next-text') && output.expectedRoleId === null) {
      fail('MISSING_EXPECTED_ROLE', `${context} needs an expected input role.`, {
        outputId: output.id
      });
    }
    if (output.enabled && output.expectedRoleId !== null && !enabledRoleIds.has(output.expectedRoleId)) {
      fail('DISABLED_EXPECTED_ROLE', `${context} uses a disabled input role.`, {
        outputId: output.id,
        roleId: output.expectedRoleId
      });
    }
    if (output.enabled && output.sourceRoleId !== null && !enabledRoleIds.has(output.sourceRoleId)) {
      fail('DISABLED_SOURCE_ROLE', `${context} uses a disabled input role.`, {
        outputId: output.id,
        roleId: output.sourceRoleId
      });
    }
    if (typeof output.operatorPreview !== 'boolean') {
      fail('INVALID_OPERATOR_PREVIEW', `${context}.operatorPreview must be true or false.`);
    }
    if (output.displayFingerprint !== null && typeof output.displayFingerprint !== 'string') {
      fail('INVALID_DISPLAY_FINGERPRINT', `${context}.displayFingerprint must be a string or null.`);
    }
    normalizeLegacyDisplayId(output.legacyDisplayId, `${context}.legacyDisplayId`);
    validateRoute(output, context, roleIds, outputIds);
    if (output.sourceOutputId === output.id) {
      fail('SELF_MIRROR', `${context} cannot mirror itself.`, { outputId: output.id });
    }
    if (output.fallback !== null) {
      if (!isRecord(output.fallback)) {
        fail('INVALID_OUTPUT_FALLBACK', `${context}.fallback must be an object or null.`);
      }
      validateRoute(output.fallback, `${context}.fallback`, roleIds, outputIds);
      if (output.enabled && output.fallback.sourceRoleId !== null
        && !enabledRoleIds.has(output.fallback.sourceRoleId)) {
        fail('DISABLED_FALLBACK_ROLE', `${context}.fallback uses a disabled input role.`, {
          outputId: output.id,
          roleId: output.fallback.sourceRoleId
        });
      }
      if (output.fallback.sourceOutputId === output.id) {
        fail('SELF_MIRROR', `${context}.fallback cannot mirror itself.`, { outputId: output.id });
      }
    }
  }
  validateMirrorCycles(profile.outputs);

  if (!Array.isArray(profile.previewOutputIds)) {
    fail('INVALID_PREVIEW_OUTPUT_IDS', 'previewOutputIds must be an array.');
  }
  const expectedPreviewIds = profile.outputs
    .filter(output => output.operatorPreview)
    .map(output => output.id);
  if (
    profile.previewOutputIds.length !== expectedPreviewIds.length
    || profile.previewOutputIds.some((id, index) => id !== expectedPreviewIds[index])
  ) {
    fail(
      'PREVIEW_OUTPUT_MISMATCH',
      'previewOutputIds must match operatorPreview outputs in output order.',
      { expectedPreviewIds }
    );
  }

  if (!isRecord(profile.transition) || !isRecord(profile.singer) || !isRecord(profile.operator)) {
    fail('INVALID_PROFILE_PREFERENCES', 'Profile preference groups are missing.');
  }
  if (profile.singer.fallbackSourceRoleId !== null && !roleIds.has(profile.singer.fallbackSourceRoleId)) {
    fail('UNKNOWN_SINGER_SOURCE_ROLE', 'Singer fallback source role does not exist.', {
      roleId: profile.singer.fallbackSourceRoleId
    });
  }
  for (const outputId of profile.operator.previewOpenOutputIds) {
    if (!outputIds.has(outputId)) {
      fail('UNKNOWN_PREVIEW_OPEN_OUTPUT', 'An open-preview preference refers to a removed output.', {
        outputId
      });
    }
  }
  return true;
}

/** Convert the settings.json contract used through v1.4 preview into Profile v1. */
function migrateLegacySettingsToVenueProfile(settings = {}, options = {}) {
  if (!isRecord(settings)) {
    fail('INVALID_LEGACY_SETTINGS', 'Legacy settings must be an object.');
  }
  if (!isRecord(options)) fail('INVALID_OPTIONS', 'Venue profile options must be an object.');

  const requestedSingerSource = firstDefined(
    settings.singerSourceRoleId,
    settings.singerSource,
    settings.singerLanguage
  );
  const singerSourceRoleId = requestedSingerSource === 'english' ? 'english' : 'russian';
  const previewOpenOutputIds = [];
  if (settings.previewOpenRu === true) previewOpenOutputIds.push('russian');
  if (settings.previewOpenEn === true) previewOpenOutputIds.push('english');
  if (
    settings.previewOpenSinger !== false
    && getLegacyPreview(settings, 'singer', true)
  ) previewOpenOutputIds.push('singer');

  return normalizeVenueProfile({
    schemaVersion: CURRENT_PROFILE_SCHEMA_VERSION,
    id: firstDefined(options.profileId, settings.profileId, 'default'),
    name: firstDefined(options.profileName, settings.profileName, 'Main Sanctuary'),
    timeZone: firstDefined(options.timeZone, settings.timeZone, null),
    serviceDateOrder: firstDefined(settings.serviceDateOrder, settings.dateOrder, 'mdy'),
    friendlyModeDefault: settings.friendlyMode !== false,
    stalenessPolicy: settings.stalenessPolicy,
    localServiceFolder: settings.localServiceFolder,
    driveConnectionId: settings.driveConnectionId,
    inputRoles: defaultInputRoles(),
    outputs: defaultOutputs(settings, singerSourceRoleId),
    transition: {
      fadeDurationMs: settings.fadeDuration,
      syncMode: settings.syncMode
    },
    singer: {
      fallbackSourceRoleId: singerSourceRoleId,
      fontSizePx: settings.singerFontSize,
      charLimit: settings.singerCharLimit,
      textPaddingPx: settings.singerTextPadding
    },
    operator: {
      advancedWarningAcknowledged: settings.advancedWarningAcknowledged,
      thumbnailZoomPercent: settings.thumbnailZoom,
      previewOpenOutputIds
    }
  }, options);
}

/**
 * Migrate legacy settings, an unversioned profile, or a persisted profile to v1.
 * Future schema versions are rejected instead of being silently downgraded.
 */
function migrateVenueProfile(value = {}, options = {}) {
  if (!isRecord(value)) fail('INVALID_PROFILE', 'Venue profile data must be an object.');

  const candidate = isRecord(value.venueProfile) ? value.venueProfile : value;
  if (candidate.schemaVersion !== undefined) {
    assertKnownSchemaVersion(candidate.schemaVersion);
    return normalizeVenueProfile(candidate, options);
  }

  const looksLikeProfile = Array.isArray(candidate.inputRoles)
    || Array.isArray(candidate.outputs)
    || candidate.friendlyModeDefault !== undefined
    || candidate.stalenessPolicy !== undefined;
  return looksLikeProfile
    ? normalizeVenueProfile(candidate, options)
    : migrateLegacySettingsToVenueProfile(candidate, options);
}

/** Return a deeply frozen show-safe snapshot detached from the caller's object. */
function resolveVenueProfile(value = {}, options = {}) {
  return deepFreeze(migrateVenueProfile(value, options));
}

/** Allocate an ID for a newly added role/output without coupling identity to its label. */
function createStableId(prefix, existingIds = []) {
  const base = normalizeId(prefix, undefined, 'prefix');
  if (!Array.isArray(existingIds) && !(existingIds instanceof Set)) {
    fail('INVALID_EXISTING_IDS', 'existingIds must be an array or Set.');
  }
  const occupied = new Set(existingIds);
  if (!occupied.has(base)) return base;
  let suffix = 2;
  while (occupied.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

module.exports = {
  CURRENT_PROFILE_SCHEMA_VERSION,
  DATE_POLICIES,
  INPUT_KINDS,
  INPUT_REQUIREMENTS,
  MAX_FILENAME_MATCHERS_PER_ROLE,
  MAX_FILENAME_MATCHER_LENGTH,
  OUTPUT_KINDS,
  OUTPUT_MODES,
  OUTPUT_RENDERERS,
  SERVICE_DATE_ORDERS,
  STALENESS_POLICIES,
  VenueProfileError,
  createStableId,
  migrateLegacySettingsToVenueProfile,
  migrateVenueProfile,
  normalizeVenueProfile,
  resolveVenueProfile,
  validateVenueProfile
};
