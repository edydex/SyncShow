'use strict';
(function expose(root) {
  function externalDisplays(displays = []) {
    return displays.filter(display => !display.isControl);
  }

  function presentationMode(displays, preference = 'auto') {
    if (preference === 'single' || preference === 'configured') return preference;
    return externalDisplays(displays).length <= 1 ? 'single' : 'configured';
  }

  function singleScreenRoles(roles = [], presentations = {}, outputs = []) {
    return roles.filter(role => {
      const deck = presentations[role.id];
      if (!role.enabled || role.kind !== 'deck' || !deck || deck.loaded === false || deck.pending || !(deck.slideCount > 0)) return false;
      // A dedicated stage deck is not an audience language. Unassigned legacy
      // decks are still valid choices when a projector is connected elsewhere.
      const routes = outputs.filter(output => output.expectedRoleId === role.id);
      return !routes.length || routes.some(output => output.kind === 'normal');
    });
  }

  function singleScreenOutput({ roleId, displayId, displays, roles, presentations, outputs = [] }) {
    const display = externalDisplays(displays).find(item => String(item.id) === String(displayId));
    if (!display) throw new Error('That presentation screen is no longer connected. Choose a connected external screen.');
    const role = singleScreenRoles(roles, presentations, outputs).find(item => item.id === roleId);
    if (!role) throw new Error('That language is no longer loaded. Load the service and choose a language again.');
    const configured = outputs.find(output => output.kind === 'normal' && output.expectedRoleId === role.id);
    return {
      id: configured?.id || 'single-screen',
      name: role.name || role.label || role.id,
      kind: 'normal', enabled: true, expectedRole: role.id,
      displayId: display.id, operatorPreview: false
    };
  }

  const api = { externalDisplays, presentationMode, singleScreenRoles, singleScreenOutput };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.SyncShowPresentationMode = api;
})(typeof window !== 'undefined' ? window : null);
