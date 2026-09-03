/**
 * Turn Electron IPC rejection wrappers into messages suitable for operators.
 *
 * Electron intentionally prefixes errors returned by ipcRenderer.invoke().
 * That transport detail is useful in the console, but it should never appear
 * in SyncShow's status bar or Admin Settings.
 */
(function exposeErrorMessages(root) {
  'use strict';

  const CLOSE_POWERPOINT_AND_RETRY_ACTION = 'close-powerpoint-and-retry';

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

  function normalizePresentationConversionFailure(
    result,
    fallback = 'The presentation could not be converted.'
  ) {
    const structured = result?.success === false
      && result.error
      && typeof result.error === 'object'
      && !Array.isArray(result.error)
      && result.error.schemaVersion === 1;
    const rawError = structured
      ? result.error
      : { message: typeof result?.error === 'string' ? result.error : '' };
    const code = structured
      && typeof rawError.code === 'string'
      && /^[A-Z][A-Z0-9_]{1,79}$/.test(rawError.code)
      ? rawError.code
      : 'PRESENTATION_CONVERSION_FAILED';
    const recoveryAction = structured
      && rawError.retryable === true
      && rawError.recoveryAction === CLOSE_POWERPOINT_AND_RETRY_ACTION
      ? CLOSE_POWERPOINT_AND_RETRY_ACTION
      : null;

    return Object.freeze({
      code,
      message: humanizeIpcError(rawError, fallback),
      retryable: recoveryAction !== null,
      recoveryAction
    });
  }

  const api = Object.freeze({
    CLOSE_POWERPOINT_AND_RETRY_ACTION,
    humanizeIpcError,
    normalizePresentationConversionFailure
  });
  root.SyncShowErrorMessages = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis === 'undefined' ? window : globalThis);
