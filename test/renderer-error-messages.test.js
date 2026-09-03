'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CLOSE_POWERPOINT_AND_RETRY_ACTION,
  humanizeIpcError,
  normalizePresentationConversionFailure
} = require('../src/renderer/error-messages');

test('renderer error messages remove Electron IPC transport prefixes', () => {
  assert.equal(
    humanizeIpcError(
      new Error(
        "Error invoking remote method 'drive:linkPublic': Error: This folder is not public."
      ),
      'fallback'
    ),
    'This folder is not public.'
  );
  assert.equal(
    humanizeIpcError(
      new Error(
        "Error: Error invoking remote method 'drive:connectPrivate': Error: Google sign-in was cancelled."
      ),
      'fallback'
    ),
    'Google sign-in was cancelled.'
  );
});

test('renderer error messages preserve useful errors and provide a safe fallback', () => {
  assert.equal(
    humanizeIpcError(new Error('Choose a Google Drive folder.'), 'fallback'),
    'Choose a Google Drive folder.'
  );
  assert.equal(humanizeIpcError(null, 'Drive is unavailable.'), 'Drive is unavailable.');
  assert.equal(humanizeIpcError({ message: '   ' }, 'Drive is unavailable.'), 'Drive is unavailable.');
});

test('renderer accepts only the versioned PowerPoint recovery action', () => {
  const failure = normalizePresentationConversionFailure({
    success: false,
    error: {
      schemaVersion: 1,
      code: 'POWERPOINT_IN_USE',
      message: 'Close PowerPoint, then retry.',
      retryable: true,
      recoveryAction: CLOSE_POWERPOINT_AND_RETRY_ACTION
    }
  });

  assert.deepEqual(failure, {
    code: 'POWERPOINT_IN_USE',
    message: 'Close PowerPoint, then retry.',
    retryable: true,
    recoveryAction: CLOSE_POWERPOINT_AND_RETRY_ACTION
  });
  assert.equal(Object.isFrozen(failure), true);

  const unversioned = normalizePresentationConversionFailure({
    success: false,
    error: {
      code: 'POWERPOINT_IN_USE',
      message: 'unversioned',
      retryable: true,
      recoveryAction: CLOSE_POWERPOINT_AND_RETRY_ACTION
    }
  });
  assert.equal(unversioned.retryable, false);
  assert.equal(unversioned.recoveryAction, null);
});

test('renderer keeps legacy string failures non-retryable', () => {
  assert.deepEqual(
    normalizePresentationConversionFailure({
      success: false,
      error: 'Legacy conversion failure'
    }),
    {
      code: 'PRESENTATION_CONVERSION_FAILED',
      message: 'Legacy conversion failure',
      retryable: false,
      recoveryAction: null
    }
  );
});
