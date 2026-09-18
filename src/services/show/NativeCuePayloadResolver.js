'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  deriveNativeSingerScene,
  nativeSceneSingerNext,
  sceneAssetIds
} = require('./NativeCueScene');

const NATIVE_CUE_VARIANTS = new Set([
  null,
  'singer-current-next'
]);

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function usableAssetPath(assetPath) {
  if (typeof assetPath !== 'string' || !path.isAbsolute(assetPath)) return false;
  try {
    return fs.statSync(assetPath).isFile();
  } catch (_error) {
    return false;
  }
}

/**
 * Resolve one prepared native presentation cue into the exact display payload.
 *
 * Invalid presentation state, an unknown route variant, a malformed scene, or
 * an unavailable asset all fail closed with null so callers never send a
 * partial native cue to an output window.
 */
function resolveNativeCuePayload({
  presentation,
  cueIndex,
  variant = null
} = {}) {
  if (
    !isRecord(presentation)
    || presentation.renderer !== 'native-cue'
    || !Array.isArray(presentation.scenes)
    || !isRecord(presentation.assetPaths)
    || !Number.isSafeInteger(cueIndex)
    || cueIndex < 0
    || !presentation.scenes[cueIndex]
    || !NATIVE_CUE_VARIANTS.has(variant)
  ) {
    return null;
  }

  try {
    const currentScene = presentation.scenes[cueIndex];
    const scene = variant === 'singer-current-next'
      ? deriveNativeSingerScene(
          currentScene,
          nativeSceneSingerNext(presentation.scenes[cueIndex + 1] || null)
        )
      : currentScene;
    const assetPaths = {};
    for (const assetId of sceneAssetIds(scene)) {
      const assetPath = presentation.assetPaths[assetId];
      if (!usableAssetPath(assetPath)) return null;
      assetPaths[assetId] = assetPath;
    }
    return { scene, assetPaths };
  } catch (_error) {
    return null;
  }
}

module.exports = {
  NATIVE_CUE_VARIANTS,
  resolveNativeCuePayload
};
