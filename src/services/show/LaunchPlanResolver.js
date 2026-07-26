'use strict';

const DECISION_MODES = new Set([
  'direct',
  'mirror',
  'derive-next-text',
  'disabled'
]);

const OUTPUT_KINDS = new Set(['normal', 'singer']);

class LaunchPlanError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'LaunchPlanError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new LaunchPlanError(code, message, details);
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isDisplayId(value) {
  return (typeof value === 'string' && value.trim().length > 0)
    || (typeof value === 'number' && Number.isFinite(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function validateInputs({ presentations, outputs, decisions }) {
  if (!isRecord(presentations)) {
    fail('INVALID_PRESENTATIONS', 'Presentations must be an object keyed by role.');
  }
  if (!Array.isArray(outputs)) {
    fail('INVALID_OUTPUTS', 'Outputs must be an array.');
  }
  if (!isRecord(decisions)) {
    fail('INVALID_DECISIONS', 'Per-service decisions must be an object keyed by output ID.');
  }

  const outputIds = new Set();
  for (const [index, output] of outputs.entries()) {
    if (!isRecord(output)) {
      fail('INVALID_OUTPUT', `Output ${index + 1} must be an object.`, { index });
    }
    if (!isNonEmptyString(output.id)) {
      fail('INVALID_OUTPUT_ID', `Output ${index + 1} needs a stable ID.`, { index });
    }
    if (outputIds.has(output.id)) {
      fail('DUPLICATE_OUTPUT_ID', `Output ID "${output.id}" is used more than once.`, {
        outputId: output.id
      });
    }
    outputIds.add(output.id);

    if (!isNonEmptyString(output.name)) {
      fail('INVALID_OUTPUT_NAME', `Output "${output.id}" needs a name.`, {
        outputId: output.id
      });
    }
    if (!OUTPUT_KINDS.has(output.kind)) {
      fail('INVALID_OUTPUT_KIND', `Output "${output.name}" has an unsupported kind.`, {
        outputId: output.id,
        kind: output.kind
      });
    }
    if (output.enabled !== undefined && typeof output.enabled !== 'boolean') {
      fail('INVALID_OUTPUT_ENABLED', `Output "${output.name}" has an invalid enabled state.`, {
        outputId: output.id
      });
    }
    if (output.operatorPreview !== undefined && typeof output.operatorPreview !== 'boolean') {
      fail('INVALID_OPERATOR_PREVIEW', `Output "${output.name}" has an invalid preview setting.`, {
        outputId: output.id
      });
    }
    if (output.enabled !== false && !isNonEmptyString(output.expectedRole)) {
      fail('INVALID_EXPECTED_ROLE', `Output "${output.name}" needs an expected role.`, {
        outputId: output.id
      });
    }
  }

  for (const outputId of Object.keys(decisions)) {
    if (!outputIds.has(outputId)) {
      fail('UNKNOWN_DECISION_OUTPUT', `A decision refers to unknown output "${outputId}".`, {
        outputId
      });
    }
  }
}

function normalizeDecision(output, rawDecision) {
  const decision = rawDecision === undefined ? { mode: 'direct' } : rawDecision;
  if (!isRecord(decision) || !DECISION_MODES.has(decision.mode)) {
    fail('INVALID_DECISION', `Choose how "${output.name}" should be shown for this service.`, {
      outputId: output.id,
      mode: decision && decision.mode
    });
  }

  if (decision.mode === 'disabled') return { mode: 'disabled', sourceRoleId: null };

  if (decision.mode === 'direct') {
    if (decision.sourceRole !== undefined && decision.sourceRole !== output.expectedRole) {
      fail('INVALID_DIRECT_SOURCE', `Direct mode for "${output.name}" must use its expected role.`, {
        outputId: output.id,
        expectedRole: output.expectedRole,
        sourceRole: decision.sourceRole
      });
    }
    return { mode: 'direct', sourceRoleId: output.expectedRole };
  }

  if (!isNonEmptyString(decision.sourceRole)) {
    fail('MISSING_SOURCE_ROLE', `Choose an existing slideshow for "${output.name}".`, {
      outputId: output.id,
      mode: decision.mode
    });
  }

  if (decision.mode === 'derive-next-text' && output.kind !== 'singer') {
    fail('DERIVE_REQUIRES_SINGER', 'Next-text view is only available for a Singer output.', {
      outputId: output.id
    });
  }

  return { mode: decision.mode, sourceRoleId: decision.sourceRole };
}

function requirePresentation(presentations, roleId, output) {
  const presentation = presentations[roleId];
  if (!isRecord(presentation)) {
    fail('MISSING_PRESENTATION', `No ${roleId} slideshow is loaded for "${output.name}".`, {
      outputId: output.id,
      roleId,
      kind: output.kind
    });
  }
  if (!Number.isInteger(presentation.slideCount) || presentation.slideCount <= 0) {
    fail('INVALID_SLIDE_COUNT', `The ${roleId} slideshow is not ready to show.`, {
      outputId: output.id,
      roleId,
      slideCount: presentation.slideCount
    });
  }
  if (presentation.renderer === 'native-cue'
    && (presentation.sourceType !== 'service-project'
      || !Array.isArray(presentation.scenes)
      || presentation.scenes.length !== presentation.slideCount
      || !isRecord(presentation.assetPaths))) {
    fail('INVALID_NATIVE_PRESENTATION', `The prepared service for ${roleId} is incomplete. Prepare it for Load again.`, {
      outputId: output.id,
      roleId
    });
  }
  return presentation;
}

function presentationRenderer(presentation, decisionMode) {
  const native = presentation.renderer === 'native-cue'
    && presentation.sourceType === 'service-project';
  if (decisionMode === 'derive-next-text') {
    return native
      ? { renderer: 'native-cue', nativeVariant: 'singer-current-next' }
      : { renderer: 'singer-current-next', nativeVariant: null };
  }
  return {
    renderer: native ? 'native-cue' : 'slides',
    nativeVariant: null
  };
}

/**
 * Resolve mutable setup state into an immutable, executable show snapshot.
 *
 * @param {object} input
 * @param {Record<string, {slideCount: number}|null>} input.presentations
 * @param {Array<{id:string,name:string,kind:'normal'|'singer',displayId:string|number,expectedRole:string,enabled?:boolean}>} input.outputs
 * @param {Record<string, {mode:'direct'|'mirror'|'derive-next-text'|'disabled',sourceRole?:string}>} [input.decisions]
 * @param {string} [input.preferredTimelineRoleId]
 * @returns {{timelineRoleId:string,totalSlides:number,outputs:Array<object>}}
 * @throws {LaunchPlanError}
 */
function resolveLaunchPlan(input) {
  if (!isRecord(input)) {
    fail('INVALID_INPUT', 'Launch-plan input must be an object.');
  }

  const {
    presentations,
    outputs,
    decisions = {},
    preferredTimelineRoleId
  } = input;

  validateInputs({ presentations, outputs, decisions });

  const active = [];
  const seenDisplays = new Map();

  for (const output of outputs) {
    if (output.enabled === false) continue;

    const decision = normalizeDecision(output, decisions[output.id]);
    if (decision.mode === 'disabled') continue;

    if (!isDisplayId(output.displayId)) {
      fail('MISSING_DISPLAY', `Choose a physical display for "${output.name}".`, {
        outputId: output.id
      });
    }

    const displayKey = String(output.displayId);
    const conflictingOutputId = seenDisplays.get(displayKey);
    if (conflictingOutputId) {
      fail('DISPLAY_COLLISION', 'Each active output must use a different physical display.', {
        displayId: output.displayId,
        outputIds: [conflictingOutputId, output.id]
      });
    }
    seenDisplays.set(displayKey, output.id);

    const presentation = requirePresentation(presentations, decision.sourceRoleId, output);
    const presentationRoute = presentationRenderer(presentation, decision.mode);
    active.push({
      id: output.id,
      name: output.name,
      displayId: output.displayId,
      renderer: presentationRoute.renderer,
      sourceRoleId: decision.sourceRoleId,
      ...(presentationRoute.nativeVariant
        ? { nativeVariant: presentationRoute.nativeVariant }
        : {}),
      // Preserve the legacy Singer default for profiles migrated from older
      // settings, while allowing any named output (or several outputs) to be
      // selected for the operator's Show-screen preview.
      operatorPreview: output.operatorPreview === undefined
        ? output.id === 'singer'
        : output.operatorPreview,
      slideCount: presentation.slideCount
    });
  }

  if (active.length === 0) {
    fail('NO_ENABLED_OUTPUTS', 'Turn on at least one output for this service.');
  }

  const roleCounts = new Map();
  for (const output of active) {
    if (!roleCounts.has(output.sourceRoleId)) {
      roleCounts.set(output.sourceRoleId, output.slideCount);
    }
  }

  const distinctCounts = new Set(roleCounts.values());
  if (distinctCounts.size > 1) {
    fail(
      'SLIDE_COUNT_MISMATCH',
      'Independently routed slideshows have different slide counts. Replace one, mirror a matching slideshow, or turn off an affected output.',
      {
        roles: [...roleCounts].map(([roleId, slideCount]) => ({ roleId, slideCount })),
        outputIds: active.map(output => output.id)
      }
    );
  }

  const usedRoleIds = new Set(active.map(output => output.sourceRoleId));
  const timelineRoleId = isNonEmptyString(preferredTimelineRoleId)
    && usedRoleIds.has(preferredTimelineRoleId)
    ? preferredTimelineRoleId
    : active[0].sourceRoleId;
  const totalSlides = roleCounts.get(timelineRoleId);

  const plan = {
    timelineRoleId,
    totalSlides,
    outputs: active.map(({ slideCount, ...output }) => output)
  };

  return deepFreeze(plan);
}

module.exports = {
  LaunchPlanError,
  resolveLaunchPlan
};
