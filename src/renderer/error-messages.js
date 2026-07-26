/**
 * Turn Electron IPC rejection wrappers into messages suitable for operators.
 *
 * Electron intentionally prefixes errors returned by ipcRenderer.invoke().
 * That transport detail is useful in the console, but it should never appear
 * in SyncShow's status bar or Admin Settings.
 */
(function exposeErrorMessages(root) {
  'use strict';

  function humanizeIpcError(error, fallback = 'SyncShow could not complete that action.') {
    let message = typeof error?.message === 'string' ? error.message.trim() : '';
    let previous;

    // Electron and main-process Error objects can each contribute an "Error:"
    // wrapper. Remove all leading transport wrappers while preserving the
    // actual, intentionally-written main-process message.
    do {
      previous = message;
      message = message
        .replace(/^Error invoking remote method '[^']+':\s*/u, '')
        .replace(/^Error:\s*/u, '')
        .trim();
    } while (message && message !== previous);

    return message || fallback;
  }

  const api = Object.freeze({ humanizeIpcError });
  root.SyncShowErrorMessages = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis === 'undefined' ? window : globalThis);
