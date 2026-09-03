'use strict';

const PowerPointStrategy = require('./strategies/PowerPointStrategy');

const PRESENTATION_CONVERSION_FAILED_CODE = 'PRESENTATION_CONVERSION_FAILED';
const CLOSE_POWERPOINT_AND_RETRY_ACTION = 'close-powerpoint-and-retry';
const MAX_OPERATOR_MESSAGE_LENGTH = 1000;

function safeErrorCode(value) {
  if (typeof value !== 'string' || !/^[A-Z][A-Z0-9_]{1,79}$/.test(value)) {
    return null;
  }
  return value;
}

function safeErrorMessage(error) {
  const message = typeof error?.message === 'string'
    ? error.message.trim()
    : '';
  if (!message) return 'The presentation could not be converted.';
  return message.slice(0, MAX_OPERATOR_MESSAGE_LENGTH);
}

function hasPowerPointInUseCause(error) {
  return [
    error?.code,
    error?.powerPointError?.code
  ].includes(PowerPointStrategy.POWERPOINT_IN_USE_CODE);
}

/**
 * Return a deliberately small, cloneable IPC response. Electron does not
 * preserve custom Error fields across ipcRenderer.invoke() rejections, so the
 * renderer must receive retry metadata as ordinary data.
 */
function serializeConversionFailure(error) {
  const powerPointInUse = hasPowerPointInUseCause(error);
  const code = safeErrorCode(error?.code) || PRESENTATION_CONVERSION_FAILED_CODE;

  let message = safeErrorMessage(error);
  if (powerPointInUse) {
    message = error?.powerPointError
      ? 'PowerPoint was open and the LibreOffice fallback also could not convert this slideshow. Close PowerPoint, then retry.'
      : 'PowerPoint is open. Close PowerPoint, then retry. SyncShow will not close or change PowerPoint.';
  }

  return {
    success: false,
    error: {
      schemaVersion: 1,
      code,
      message,
      retryable: powerPointInUse,
      recoveryAction: powerPointInUse
        ? CLOSE_POWERPOINT_AND_RETRY_ACTION
        : null
    }
  };
}

module.exports = {
  CLOSE_POWERPOINT_AND_RETRY_ACTION,
  MAX_OPERATOR_MESSAGE_LENGTH,
  PRESENTATION_CONVERSION_FAILED_CODE,
  serializeConversionFailure
};
