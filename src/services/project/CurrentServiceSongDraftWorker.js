'use strict';

const {
  Worker,
  isMainThread,
  parentPort,
  workerData
} = require('worker_threads');

const MAX_SOURCE_BYTES = 128 * 1024 * 1024;
const MAX_OPTIONS_BYTES = 64 * 1024;
const MAX_ACTIVE_JOBS = 2;
const DEFAULT_JOB_TIMEOUT_MS = 30_000;
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const ACTIONS = Object.freeze({
  build: 'build',
  inspect: 'inspect'
});

let activeJobs = 0;

class CurrentServiceSongDraftWorkerError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CurrentServiceSongDraftWorkerError';
    this.code = ERROR_CODE_PATTERN.test(String(code || ''))
      ? code
      : 'SONG_DRAFT_WORKER_FAILED';
    this.details = deepFreeze(
      details && typeof details === 'object' && !Array.isArray(details)
        ? { ...details }
        : {}
    );
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function fail(code, message, details = {}) {
  throw new CurrentServiceSongDraftWorkerError(code, message, details);
}

function assertSourceBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 1) {
    fail(
      'INVALID_PPTX',
      'PowerPoint source bytes must be a non-empty Buffer.'
    );
  }
  if (buffer.length > MAX_SOURCE_BYTES) {
    fail(
      'PPTX_TOO_LARGE',
      `The PowerPoint source exceeds the ${MAX_SOURCE_BYTES}-byte worker limit.`,
      { maximumBytes: MAX_SOURCE_BYTES, sizeBytes: buffer.length }
    );
  }
}

function cloneWorkerOptions(value) {
  if (value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('INVALID_DRAFT_OPTIONS', 'Song draft worker options must be an object.');
  }
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch (_error) {
    fail('INVALID_DRAFT_OPTIONS', 'Song draft worker options must be serializable.');
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_OPTIONS_BYTES) {
    fail(
      'INVALID_DRAFT_OPTIONS',
      'Song draft worker options exceed the safe request limit.',
      { maximumBytes: MAX_OPTIONS_BYTES }
    );
  }
  return JSON.parse(serialized);
}

function publicWorkerError(raw) {
  const code = ERROR_CODE_PATTERN.test(String(raw?.code || ''))
    ? raw.code
    : 'SONG_DRAFT_WORKER_FAILED';
  const message = typeof raw?.message === 'string'
    && raw.message.length > 0
    && raw.message.length <= 2_000
    ? raw.message
    : 'The PowerPoint song review worker failed.';
  const details = raw?.details
    && typeof raw.details === 'object'
    && !Array.isArray(raw.details)
    ? raw.details
    : {};
  return new CurrentServiceSongDraftWorkerError(code, message, details);
}

function serializeWorkerError(error) {
  return {
    code: ERROR_CODE_PATTERN.test(String(error?.code || ''))
      ? error.code
      : 'SONG_DRAFT_WORKER_FAILED',
    message: typeof error?.message === 'string'
      ? error.message.slice(0, 2_000)
      : 'The PowerPoint song review worker failed.',
    details: error?.details
      && typeof error.details === 'object'
      && !Array.isArray(error.details)
      ? error.details
      : {}
  };
}

async function executeWorkerAction(action, sourceBytes, options) {
  const {
    buildPptxSongDraft,
    inspectPptxSongSlides
  } = require('./CurrentServiceSongDraft');
  const buffer = Buffer.from(sourceBytes);
  if (action === ACTIONS.inspect) return inspectPptxSongSlides(buffer);
  if (action === ACTIONS.build) return buildPptxSongDraft(buffer, options);
  fail('INVALID_WORKER_ACTION', 'The PowerPoint song review action is unsupported.');
}

function runWorkerAction(action, buffer, options = undefined, runtime = {}) {
  if (!isMainThread) {
    return Promise.reject(
      new CurrentServiceSongDraftWorkerError(
        'INVALID_WORKER_CONTEXT',
        'A PowerPoint song worker cannot start another worker.'
      )
    );
  }
  if (!Object.values(ACTIONS).includes(action)) {
    return Promise.reject(
      new CurrentServiceSongDraftWorkerError(
        'INVALID_WORKER_ACTION',
        'The PowerPoint song review action is unsupported.'
      )
    );
  }
  try {
    assertSourceBuffer(buffer);
  } catch (error) {
    return Promise.reject(error);
  }
  if (activeJobs >= MAX_ACTIVE_JOBS) {
    return Promise.reject(
      new CurrentServiceSongDraftWorkerError(
        'SONG_DRAFT_WORKER_BUSY',
        'Another PowerPoint song review is already using the safe worker limit.'
      )
    );
  }
  let workerOptions;
  try {
    workerOptions = action === ACTIONS.build
      ? cloneWorkerOptions(options)
      : null;
  } catch (error) {
    return Promise.reject(error);
  }
  const timeoutMs = Number.isSafeInteger(runtime.timeoutMs)
    && runtime.timeoutMs >= 100
    && runtime.timeoutMs <= DEFAULT_JOB_TIMEOUT_MS
    ? runtime.timeoutMs
    : DEFAULT_JOB_TIMEOUT_MS;
  const sourceBytes = Uint8Array.from(buffer);
  activeJobs += 1;

  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker(__filename, {
        workerData: {
          action,
          sourceBytes,
          options: workerOptions
        },
        transferList: [sourceBytes.buffer],
        resourceLimits: {
          maxOldGenerationSizeMb: 256,
          maxYoungGenerationSizeMb: 32,
          stackSizeMb: 4
        }
      });
    } catch (error) {
      activeJobs -= 1;
      reject(
        new CurrentServiceSongDraftWorkerError(
          'SONG_DRAFT_WORKER_FAILED',
          'The PowerPoint song review worker could not be started.',
          { cause: String(error?.message || '').slice(0, 500) }
        )
      );
      return;
    }
    let settled = false;
    let timeout = null;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      activeJobs -= 1;
      callback(value);
    };
    const rejectAfterTermination = error => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      let termination;
      try {
        termination = worker.terminate();
      } catch (_error) {
        termination = null;
      }
      Promise.resolve(termination)
        .catch(() => undefined)
        .then(() => {
          activeJobs -= 1;
          reject(error);
        });
    };
    timeout = setTimeout(() => {
      rejectAfterTermination(
        new CurrentServiceSongDraftWorkerError(
          'SONG_DRAFT_WORKER_TIMEOUT',
          'PowerPoint song review exceeded its safe processing deadline.',
          { timeoutMs }
        )
      );
    }, timeoutMs);
    worker.once('message', message => {
      if (!message || typeof message !== 'object' || Array.isArray(message)) {
        rejectAfterTermination(
          new CurrentServiceSongDraftWorkerError(
            'SONG_DRAFT_WORKER_FAILED',
            'The PowerPoint song review worker returned an invalid result.'
          )
        );
        return;
      }
      if (message.ok === true) {
        finish(resolve, deepFreeze(message.result));
        return;
      }
      finish(reject, publicWorkerError(message.error));
    });
    worker.once('error', error => {
      finish(
        reject,
        new CurrentServiceSongDraftWorkerError(
          'SONG_DRAFT_WORKER_FAILED',
          'The PowerPoint song review worker stopped unexpectedly.',
          { cause: String(error?.message || '').slice(0, 500) }
        )
      );
    });
    worker.once('exit', code => {
      if (settled || code === 0) return;
      finish(
        reject,
        new CurrentServiceSongDraftWorkerError(
          'SONG_DRAFT_WORKER_FAILED',
          'The PowerPoint song review worker exited before returning a result.',
          { exitCode: code }
        )
      );
    });
  });
}

function inspectPptxSongSlidesInWorker(buffer, runtime = {}) {
  return runWorkerAction(ACTIONS.inspect, buffer, undefined, runtime);
}

function buildPptxSongDraftInWorker(buffer, options, runtime = {}) {
  return runWorkerAction(ACTIONS.build, buffer, options, runtime);
}

if (!isMainThread) {
  executeWorkerAction(
    workerData?.action,
    workerData?.sourceBytes,
    workerData?.options
  )
    .then(result => {
      parentPort.postMessage({ ok: true, result });
    })
    .catch(error => {
      parentPort.postMessage({ ok: false, error: serializeWorkerError(error) });
    });
}

module.exports = {
  CurrentServiceSongDraftWorkerError,
  buildPptxSongDraftInWorker,
  inspectPptxSongSlidesInWorker
};
