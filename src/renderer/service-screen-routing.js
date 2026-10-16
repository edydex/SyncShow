'use strict';
(function expose(root) {
  function enabledOutputs(outputs, presentations, selection) {
    return outputs.filter(output => output.enabled || (selection && selection.screenIds.includes(presentations[output.expectedRoleId]?.presentationScreenId)));
  }

  function selectedRoles(roles, presentations, selection) {
    return roles.map(role => ({...role, enabled: role.enabled && (!selection
      || selection.screenIds.includes(presentations[role.id]?.presentationScreenId))}));
  }

  function presentationOutputs(outputs, presentations, selection, displays, automatic) {
    if (!selection) return outputs;
    const selected = outputs.filter(output => selection.screenIds.includes(presentations[output.expectedRole]?.presentationScreenId));
    if (!automatic) return selected;
    const external = displays.filter(display => !display.isControl);
    const used = new Set();
    // Keep valid assignments first, including a screen later in the list.
    const reserved = new Map();
    for (const output of selected) {
      if (external.some(display => String(display.id) === String(output.displayId)) && !used.has(String(output.displayId))) {
        reserved.set(output.id, output.displayId); used.add(String(output.displayId));
      }
    }
    return selected.map(output => {
      const assigned = reserved.get(output.id);
      const available = assigned !== undefined ? null : external.find(display => !used.has(String(display.id)));
      const displayId = assigned ?? available?.id ?? null;
      if (displayId !== null) used.add(String(displayId));
      return {...output, displayId, usesOperatorDisplay: false};
    });
  }

  const api = {enabledOutputs, selectedRoles, presentationOutputs};
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SyncShowScreenRouting = api;
})(typeof globalThis === 'object' ? globalThis : this);
