'use strict';

const { createHash } = require('node:crypto');

// A mode is not a monitor identity. Keep v1 as a migration alias, but prefer
// the OS display ID plus a mode-independent, non-reversible platform label.
// Labels can describe a model rather than a unique unit: callers must never
// choose between duplicate labels without the saved OS ID.
function describeDisplay(display, index, { platform, primaryId, controlId }) {
  const legacyFingerprint = [
    'display-v1', platform, display.internal ? 'internal' : 'external',
    `${display.size?.width || display.bounds.width}x${display.size?.height || display.bounds.height}`,
    `scale-${display.scaleFactor || 1}`, `rotation-${display.rotation || 0}`,
    `touch-${display.touchSupport || 'unknown'}`
  ].join(':');
  const nativeLabel = typeof display.label === 'string' ? display.label.trim().toLowerCase() : '';
  const fingerprint = nativeLabel
    ? `display-v2:${platform}:${display.internal ? 'internal' : 'external'}:label-${createHash('sha256').update(nativeLabel).digest('hex')}`
    : legacyFingerprint;
  return {
    id: display.id, index, fingerprint, legacyFingerprint,
    label: `Display ${index + 1}${display.internal ? ' (Built-in)' : ''} - ${display.bounds.width}x${display.bounds.height}`,
    bounds: display.bounds,
    isPrimary: String(display.id) === String(primaryId),
    isControl: String(display.id) === String(controlId),
    internal: display.internal === true,
    scaleFactor: display.scaleFactor, rotation: display.rotation,
    displayFrequency: display.displayFrequency, detected: display.detected
  };
}

module.exports = { describeDisplay };
