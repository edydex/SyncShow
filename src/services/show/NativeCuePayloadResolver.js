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
  variant = null,
  stageFacing = false
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
    const nextScene = presentation.scenes[cueIndex + 1] || null;
    let next = nativeSceneSingerNext(nextScene);
    // A hidden title image still has an operator label for the next-slide clue.
    if (next.state === 'blank' && nextScene && nextScene.layout !== 'blank') {
      const label = presentation.metadata?.slides?.[cueIndex + 1]?.firstLine;
      if (typeof label === 'string' && label.trim()) next = {state: 'text', text: label.split(/\r?\n/)[0].slice(0, 300)};
    }
    const scene = variant === 'singer-current-next' || (stageFacing && currentScene.layout === 'blank')
      ? deriveNativeSingerScene(
          currentScene,
          next
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
