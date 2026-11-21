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

  const FINGERPRINT_CLASS = /^display-v[12]:([^:]+):(internal|external):/u;
  const MODE_FINGERPRINT = /^display-v1:([^:]+):(internal|external):\d+x\d+:scale-[^:]+:rotation-[^:]+:touch-[^:]+$/u;
  // Exhaustive matching is exact for real venues (a handful of screens);
  // beyond this many combinations fall back to best-first assignment.
  const MAX_SEARCH_COMBINATIONS = 200000;

  function hasSavedId(output) {
    return output.legacyDisplayId !== null && output.legacyDisplayId !== undefined;
  }

  function hasSavedScreen(output) {
    return isRecord(output) && (hasSavedId(output) || isNonEmptyString(output.displayFingerprint));
  }

  // Electron reserves -1 for an unknown ID and -10 for a virtual unified
  // desktop. Neither is a safely remembered physical presentation output.
  function usableDisplays(displays) {
    return (Array.isArray(displays) ? displays : [])
      .filter(display => isRecord(display) && !['-1', '-10'].includes(String(display.id)));
  }

  function sameOrigin(saved, bounds) {
    return isRecord(saved) && isRecord(bounds) && Number.isFinite(saved.x) && Number.isFinite(saved.y)
      && saved.x === bounds.x && saved.y === bounds.y;
  }

  // Windows can renumber screens after a reboot, sleep, driver update or a
  // different cable order, and identical TVs report the same name. The place
  // in the Windows screen layout where this output last ran tells them apart.
  function rememberedAt(output, display) {
    if (sameOrigin(output.displayBounds, display.bounds)) return true;
    return Array.isArray(display.rememberedFor) && display.rememberedFor.some(entry => isRecord(entry)
      && entry.outputId === output.id
      && String(entry.legacyDisplayId ?? '') === String(output.legacyDisplayId ?? '')
      && (entry.displayFingerprint ?? null) === (output.displayFingerprint ?? null));
  }

  function nameUnavailable(display) {
    if (typeof display.nameAvailable === 'boolean') return !display.nameAvailable;
    return typeof display.fingerprint === 'string' && display.fingerprint === display.legacyFingerprint;
  }

  function evaluateCandidate(output, display) {
    const saved = isNonEmptyString(output.displayFingerprint) ? output.displayFingerprint : null;
    const idMatch = hasSavedId(output) && String(display.id) === String(output.legacyDisplayId);
    const position = rememberedAt(output, display);
    if (!saved) return idMatch ? { display, reason: 'saved-id', score: 2 } : null;
    if (display.fingerprint === saved || display.legacyFingerprint === saved) {
      return { display, score: 8 + (position ? 4 : 0) + (idMatch ? 2 : 0),
        reason: idMatch ? 'saved-id-and-fingerprint' : position ? 'fingerprint-and-position' : 'unique-fingerprint' };
    }
    const savedClass = FINGERPRINT_CLASS.exec(saved);
    const current = display.legacyFingerprint || display.fingerprint;
    const sameClass = Boolean(savedClass) && typeof current === 'string'
      && current.startsWith(`display-v1:${savedClass[1]}:${savedClass[2]}:`);
    // Older releases stored only mode information. The same OS ID is
    // stronger evidence than resolution/scaling/rotation; allow that old
    // mode to change, but never cross platform or built-in/external class.
    if (idMatch && sameClass && MODE_FINGERPRINT.test(saved)) {
      return { display, reason: 'saved-id-mode-changed', score: 2 + (position ? 4 : 0) };
    }
    // A TV that was off when the computer started, or sits behind an HDMI
    // extender, can report no name. Keep it only on the same OS ID or the
    // remembered layout position, never across built-in/external class.
    if (sameClass && saved.startsWith('display-v2:') && nameUnavailable(display) && (idMatch || position)) {
      return { display, reason: 'screen-name-unavailable', score: (position ? 4 : 0) + (idMatch ? 2 : 0) };
    }
    return null;
  }

  // Match a set of outputs together so two outputs can never claim the same
  // screen. Prefer assigning the most outputs, then the strongest evidence.
  // When two equally good assignments disagree about an output, that output
  // stays unassigned ("ambiguous") rather than silently using the wrong TV.
  function matchOutputDisplays(outputs, displays = []) {
    const list = Array.isArray(outputs) ? outputs : [];
    const usable = usableDisplays(displays);
    const candidates = list.map(output => hasSavedScreen(output)
      ? usable.map(display => evaluateCandidate(output, display)).filter(Boolean)
        .sort((a, b) => b.score - a.score)
      : []);
    const combinations = candidates.reduce((total, options) => total * (options.length + 1), 1);
    let best = { count: -1, score: -1 };
    let choices = list.map(() => new Set());
    const picked = new Array(list.length).fill(null);
    const used = new Set();
    const record = (count, score) => {
      if (count > best.count || (count === best.count && score > best.score)) {
        best = { count, score };
        choices = list.map(() => new Set());
      }
      if (count === best.count && score === best.score) {
        picked.forEach((candidate, index) => choices[index].add(candidate ? String(candidate.display.id) : null));
      }
    };
    if (combinations <= MAX_SEARCH_COMBINATIONS) {
      (function search(index, count, score) {
        if (index === list.length) return record(count, score);
        for (const candidate of candidates[index]) {
          const key = String(candidate.display.id);
          if (used.has(key)) continue;
          used.add(key);
          picked[index] = candidate;
          search(index + 1, count + 1, score + candidate.score);
          used.delete(key);
          picked[index] = null;
        }
        search(index + 1, count, score);
      }(0, 0, 0));
    } else {
      const ranked = candidates.flatMap((options, index) => options.map(candidate => ({ index, candidate })))
        .sort((a, b) => b.candidate.score - a.candidate.score);
      for (const { index, candidate } of ranked) {
        const key = String(candidate.display.id);
        if (picked[index] || used.has(key)) continue;
        used.add(key);
        picked[index] = candidate;
      }
      record(0, 0);
    }
    return list.map((output, index) => {
      const candidateIds = candidates[index].map(candidate => String(candidate.display.id));
      const result = (display, reason) => ({ display: display || null, reason, candidateIds });
      if (!hasSavedScreen(output)) return result(null, 'unassigned');
      const options = [...choices[index]];
      if (options.length === 1 && options[0] !== null) {
        const chosen = candidates[index].find(candidate => String(candidate.display.id) === options[0]);
        return result(chosen.display, chosen.reason);
      }
      if (options.length > 1) return result(null, 'ambiguous-fingerprint');
      if (candidateIds.length) return result(null, 'claimed-by-another-output');
      const byId = hasSavedId(output) && usable.some(display => String(display.id) === String(output.legacyDisplayId));
      return result(null, byId ? 'identity-changed' : 'not-connected');
    });
  }

  // `siblings` are the other outputs that will run at the same time. Without
  // them an output is matched on its own, which is what an unsaved editor
  // choice needs: show exactly the screen the operator picked.
  function matchOutputDisplay(output, displays = [], siblings = null) {
    if (!isRecord(output)) return { display: null, reason: 'unassigned', candidateIds: [] };
    const group = Array.isArray(siblings)
      ? siblings.filter(item => isRecord(item) && item !== output && !(item.id !== undefined && item.id === output.id))
      : [];
    group.unshift(output);
    return matchOutputDisplays(group, displays)[0];
  }

  // Enabled outputs share the screens; an output that is turned off is only
  // described on its own and never takes a screen from an enabled one.
  function matchProfileOutputs(outputs, displays = []) {
    const list = Array.isArray(outputs) ? outputs : [];
    const enabled = list.filter(output => isRecord(output) && output.enabled !== false);
    const joint = matchOutputDisplays(enabled, displays);
    return list.map(output => (isRecord(output) && output.enabled !== false)
      ? joint[enabled.indexOf(output)]
      : matchOutputDisplay(output, displays));
  }

  function resolveOutputDisplay(output, displays, siblings = null) {
    return matchOutputDisplay(output, displays, siblings).display;
  }

  return Object.freeze({
    createOnlyRoleDecisions,
    decisionToRouteValue,
    filterDecisionsForOutputs,
    matchOutputDisplay,
    matchOutputDisplays,
    matchProfileOutputs,
    resolveDecision,
    resolveOutputDisplay,
    routeValueToDecision
  });
}));
