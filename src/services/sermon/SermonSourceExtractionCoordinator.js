'use strict';

const MAX_EXTRACTION_KEY_LENGTH = 256;
const DEFAULT_MAX_PENDING_DISTINCT = 8;
const ABSOLUTE_MAX_PENDING_DISTINCT = 64;

class SermonSourceExtractionQueueError extends Error {
  constructor(message = 'Too many distinct sermon source extractions are pending') {
    super(message);
    this.name = 'SermonSourceExtractionQueueError';
    this.code = 'EXTRACTION_QUEUE_FULL';
  }
}

function normalizeExtractionKey(value) {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > MAX_EXTRACTION_KEY_LENGTH
  ) {
    throw new TypeError('Sermon source extraction key is invalid');
  }
  return value;
}

function normalizeMaximumPendingDistinct(value) {
  const maximum = value === undefined ? DEFAULT_MAX_PENDING_DISTINCT : value;
  if (
    !Number.isSafeInteger(maximum)
    || maximum < 1
    || maximum > ABSOLUTE_MAX_PENDING_DISTINCT
  ) {
    throw new TypeError(
      `maxPendingDistinct must be an integer between 1 and ${ABSOLUTE_MAX_PENDING_DISTINCT}`
    );
  }
  return maximum;
}

/**
 * Keep large PDF and OOXML reads deterministic under concurrent renderer
 * requests. Calls for one exact source share the same in-flight Promise, while
 * distinct sources run sequentially so they cannot multiply peak memory use.
 *
 * Settled results are deliberately not cached: attached source availability
 * and extractor behavior are checked again for a later review request.
 */
class SermonSourceExtractionCoordinator {
  constructor(options = {}) {
    const extractor = options.extractSource;
    if (extractor !== undefined && typeof extractor !== 'function') {
      throw new TypeError('Sermon source extractor must be a function');
    }
    this.extractSource = extractor || null;
    this.maxPendingDistinct = normalizeMaximumPendingDistinct(
      options.maxPendingDistinct
    );
    this.inFlight = new Map();
    this.operationTail = Promise.resolve();
  }

  run(rawKey, operation) {
    const key = normalizeExtractionKey(rawKey);
    if (typeof operation !== 'function') {
      throw new TypeError('Sermon source extraction operation must be a function');
    }
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    if (this.inFlight.size >= this.maxPendingDistinct) {
      throw new SermonSourceExtractionQueueError();
    }

    const current = this.operationTail.then(operation, operation);
    this.operationTail = current.then(() => undefined, () => undefined);
    this.inFlight.set(key, current);

    const cleanup = () => {
      if (this.inFlight.get(key) === current) this.inFlight.delete(key);
    };
    current.then(cleanup, cleanup);
    return current;
  }

  extract(sourceKey, buffer, sourceMetadata) {
    if (!this.extractSource) {
      throw new TypeError('Sermon source extraction coordinator has no extractor');
    }
    return this.run(
      sourceKey,
      () => this.extractSource(buffer, sourceMetadata)
    );
  }
}

module.exports = {
  ABSOLUTE_MAX_PENDING_DISTINCT,
  DEFAULT_MAX_PENDING_DISTINCT,
  MAX_EXTRACTION_KEY_LENGTH,
  SermonSourceExtractionCoordinator,
  SermonSourceExtractionQueueError
};
