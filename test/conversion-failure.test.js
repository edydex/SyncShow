'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CLOSE_POWERPOINT_AND_RETRY_ACTION,
  MAX_OPERATOR_MESSAGE_LENGTH,
  PRESENTATION_CONVERSION_FAILED_CODE,
  serializeConversionFailure
} = require('../src/services/converter/ConversionFailure');
const PowerPointStrategy = require(
  '../src/services/converter/strategies/PowerPointStrategy'
);

test('a PowerPoint-in-use failure crosses IPC as a bounded close-and-retry envelope', () => {
  const error = new Error('internal PowerPoint detail');
  error.code = PowerPointStrategy.POWERPOINT_IN_USE_CODE;
  error.processIds = [4242];

  assert.deepEqual(serializeConversionFailure(error), {
    success: false,
    error: {
      schemaVersion: 1,
      code: PowerPointStrategy.POWERPOINT_IN_USE_CODE,
      message:
        'PowerPoint is open. Close PowerPoint, then retry. SyncShow will not close or change PowerPoint.',
      retryable: true,
      recoveryAction: CLOSE_POWERPOINT_AND_RETRY_ACTION
    }
  });
});

test('a failed LibreOffice fallback retains the PowerPoint close-and-retry recovery', () => {
  const powerPointError = new Error('PowerPoint already running');
  powerPointError.code = PowerPointStrategy.POWERPOINT_IN_USE_CODE;
  const error = new Error('internal combined converter detail');
  error.code = 'PRESENTATION_CONVERSION_FALLBACK_FAILED';
  error.powerPointError = powerPointError;

  const envelope = serializeConversionFailure(error);
  assert.equal(envelope.error.code, 'PRESENTATION_CONVERSION_FALLBACK_FAILED');
  assert.equal(envelope.error.retryable, true);
  assert.equal(
    envelope.error.recoveryAction,
    CLOSE_POWERPOINT_AND_RETRY_ACTION
  );
  assert.match(envelope.error.message, /LibreOffice fallback/i);
  assert.doesNotMatch(envelope.error.message, /internal/i);
});

test('generic conversion failures expose no privileged retry action and stay bounded', () => {
  const error = new Error('x'.repeat(MAX_OPERATOR_MESSAGE_LENGTH + 50));
  error.code = '../unsafe-code';

  const envelope = serializeConversionFailure(error);
  assert.equal(envelope.error.code, PRESENTATION_CONVERSION_FAILED_CODE);
  assert.equal(envelope.error.message.length, MAX_OPERATOR_MESSAGE_LENGTH);
  assert.equal(envelope.error.retryable, false);
  assert.equal(envelope.error.recoveryAction, null);
});
