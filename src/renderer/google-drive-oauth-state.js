(function exposeGoogleDriveOAuthState(root, factory) {
  'use strict';

  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SyncShowGoogleDriveOAuthState = api;
}(typeof globalThis === 'object' ? globalThis : this, function createApi() {
  'use strict';

  function createInitialState() {
    return {
      active: false,
      revision: -1,
      actionBusy: false,
      actionMessage: ''
    };
  }

  function applyLifecycleState(current, payload) {
    if (!current || !Number.isSafeInteger(current.revision)) {
      throw new TypeError('Current Google Drive OAuth UI state is invalid');
    }
    const revision = Number.isSafeInteger(payload?.revision) ? payload.revision : -1;
    if (revision <= current.revision) {
      return { accepted: false, becameActive: false, state: current };
    }
    const active = payload?.active === true;
    return {
      accepted: true,
      becameActive: active && !current.active,
      state: {
        active,
        revision,
        actionBusy: false,
        actionMessage: ''
      }
    };
  }

  return Object.freeze({
    applyLifecycleState,
    createInitialState
  });
}));
