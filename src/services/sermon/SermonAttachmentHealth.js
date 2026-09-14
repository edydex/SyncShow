'use strict';

const MAX_ATTACHMENT_CHECKS = 16;
const MAX_HEALTH_RESOURCE_KEY_LENGTH = 256;
const CORRUPT_ATTACHMENT_CODES = new Set([
  'CORRUPT_SOURCE',
  'EMPTY_SOURCE',
  'INVALID_SOURCE_METADATA',
  'OBJECT_CORRUPT',
  'SOURCE_TOO_LARGE',
  'SOURCE_TYPE_MISMATCH',
  'UNSUPPORTED_SOURCE_TYPE'
]);

function freezeHealth(health) {
  return Object.freeze({ ...health });
}

/**
 * Check only this computer's private, content-addressed sermon objects.
 *
 * Availability is intentionally ephemeral: it must never be written into a
 * portable service or canonical SermonDocument. The small sequential bound
 * prevents a hostile-but-valid metadata document from causing unbounded disk
 * reads or memory pressure when an operator selects one service item.
 */
async function inspectSermonAttachmentHealth(sermon, sourceStore) {
  if (!sourceStore || typeof sourceStore.checkSource !== 'function') {
    throw new TypeError('Sermon attachment health requires a LocalSermonSourceStore');
  }
  const records = Array.isArray(sermon?.sources) ? sermon.sources : [];
  const checkedCount = Math.min(records.length, MAX_ATTACHMENT_CHECKS);
  const health = {
    totalCount: records.length,
    checkedCount,
    verifiedCount: 0,
    missingCount: 0,
    corruptCount: 0,
    unverifiedCount: records.length - checkedCount
  };

  for (const record of records.slice(0, checkedCount)) {
    try {
      await sourceStore.checkSource(record);
      health.verifiedCount += 1;
    } catch (error) {
      if (error?.code === 'OBJECT_NOT_FOUND') {
        health.missingCount += 1;
      } else if (CORRUPT_ATTACHMENT_CODES.has(error?.code)) {
        health.corruptCount += 1;
      } else {
        health.unverifiedCount += 1;
      }
    }
  }
  return freezeHealth(health);
}

function normalizeResourceKey(value) {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > MAX_HEALTH_RESOURCE_KEY_LENGTH
  ) {
    throw new TypeError('Sermon attachment health resource key is invalid');
  }
  return value;
}

/**
 * Deduplicate checks for one exact resource and serialize all distinct checks
 * through one coordinator-wide queue. `run()` is deliberately not async so a
 * duplicate caller receives the exact same Promise object as the first caller.
 *
 * Settled entries are removed from the in-flight map. Health remains
 * ephemeral, so a later request for the same resource performs a fresh check
 * instead of turning this coordinator into a cache.
 */
class SermonAttachmentHealthCoordinator {
  constructor(options = {}) {
    const inspector = options.inspectHealth || inspectSermonAttachmentHealth;
    if (typeof inspector !== 'function') {
      throw new TypeError('Sermon attachment health inspector must be a function');
    }
    this.inspectHealth = inspector;
    this.inFlight = new Map();
    this.operationTail = Promise.resolve();
  }

  run(rawResourceKey, operation) {
    const resourceKey = normalizeResourceKey(rawResourceKey);
    if (typeof operation !== 'function') {
      throw new TypeError('Sermon attachment health operation must be a function');
    }
    const existing = this.inFlight.get(resourceKey);
    if (existing) return existing;

    const current = this.operationTail.then(operation, operation);
    this.operationTail = current.then(() => undefined, () => undefined);
    this.inFlight.set(resourceKey, current);

    const cleanup = () => {
      if (this.inFlight.get(resourceKey) === current) {
        this.inFlight.delete(resourceKey);
      }
    };
    current.then(cleanup, cleanup);
    return current;
  }

  inspect(resourceKey, sermon, sourceStore) {
    return this.run(
      resourceKey,
      () => this.inspectHealth(sermon, sourceStore)
    );
  }
}

module.exports = {
  MAX_ATTACHMENT_CHECKS,
  MAX_HEALTH_RESOURCE_KEY_LENGTH,
  SermonAttachmentHealthCoordinator,
  inspectSermonAttachmentHealth
};
