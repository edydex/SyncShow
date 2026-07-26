(function exposeServiceOutputPlan(root, factory) {
  'use strict';

  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SyncShowServiceOutputPlan = api;
}(typeof globalThis === 'object' ? globalThis : this, function createApi() {
  'use strict';

  const ROUTE_MODES = new Set([
    'direct',
    'mirror',
    'derive-next-text',
    'disabled'
  ]);

  function isRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  function isNonEmptyString(value) {
    return typeof value === 'string' && value.trim().length > 0;
  }

  function normalizeDecision(decision) {
    if (!isRecord(decision) || !ROUTE_MODES.has(decision.mode)) return null;
    if (decision.mode === 'disabled' || decision.mode === 'direct') {
      return { mode: decision.mode };
    }
    if (!isNonEmptyString(decision.sourceRole)) return null;
    return {
      mode: decision.mode,
      sourceRole: decision.sourceRole
    };
  }

  function createOnlyRoleDecisions(outputs, roleId) {
    if (!Array.isArray(outputs) || !isNonEmptyString(roleId)) {
      throw new TypeError('A configured output list and slideshow role are required');
    }

    return Object.fromEntries(outputs.map(output => {
      if (!isRecord(output) || !isNonEmptyString(output.id)) {
        throw new TypeError('Every configured output needs an ID');
      }
      return [
        output.id,
        output.expectedRole === roleId
          ? { mode: 'direct' }
          : { mode: 'disabled' }
      ];
    }));
  }

  function filterDecisionsForOutputs(outputs, decisions) {
    if (!Array.isArray(outputs) || !isRecord(decisions)) return {};
    const result = {};
    for (const output of outputs) {
      if (!isRecord(output) || !isNonEmptyString(output.id)) continue;
      const decision = normalizeDecision(decisions[output.id]);
      if (decision) result[output.id] = decision;
    }
    return result;
  }

  function resolveDecision(output, presentations, decisions) {
    if (!isRecord(output) || !isNonEmptyString(output.id)) return null;
    const explicit = normalizeDecision(decisions?.[output.id]);
    if (explicit) return explicit;
    if (presentations?.[output.expectedRole]?.loaded === true) {
      return { mode: 'direct' };
    }
    return null;
  }

  function routeValueToDecision(value) {
    if (value === 'default') return null;
    if (value === 'direct' || value === 'disabled') return { mode: value };
    for (const mode of ['mirror', 'derive-next-text']) {
      const prefix = `${mode}:`;
      if (typeof value === 'string' && value.startsWith(prefix)) {
        const sourceRole = value.slice(prefix.length);
        return isNonEmptyString(sourceRole) ? { mode, sourceRole } : null;
      }
    }
    return null;
  }

  function decisionToRouteValue(decision) {
    const normalized = normalizeDecision(decision);
    if (!normalized) return 'default';
    if (normalized.mode === 'mirror' || normalized.mode === 'derive-next-text') {
      return `${normalized.mode}:${normalized.sourceRole}`;
    }
    return normalized.mode;
  }

  return Object.freeze({
    createOnlyRoleDecisions,
    decisionToRouteValue,
    filterDecisionsForOutputs,
    resolveDecision,
    routeValueToDecision
  });
}));
