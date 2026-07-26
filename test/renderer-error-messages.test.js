'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  humanizeIpcError
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
