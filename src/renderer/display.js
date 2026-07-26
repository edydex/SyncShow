/**
 * SyncDisplay - Presentation Display Window
 * Handles synchronized slide display with hardware-accelerated rendering
 */

// Display state
const displayState = {
  language: null,
  outputName: null,
  renderer: 'slides',
  displayId: null,
  currentSlide: -1,
  imageCache: new Map(),
  isReady: false,
  fadeDuration: 300,
  activeLayer: 0,  // Toggle between 0 and 1 for crossfade
  syncMode: false,  // Experimental: coordinate exact reveal timing
  navigationVersion: 0,
  pendingImageLoad: null,
  preloadRequests: new Set(),
  revealTimer: null,
  revealFrame: null,
  pendingReveal: null,
  nativeActiveLayer: 0,
  nativeRenderers: [null, null],
  fontReadiness: Promise.resolve({ ok: true })
};

// DOM Elements
const elements = {
  container: document.getElementById('displayContainer'),
  noSlide: document.getElementById('noSlide'),
  // Two layers for crossfade effect
  layers: [
    document.getElementById('slide-layer-0'),
    document.getElementById('slide-layer-1')
  ],
  nativeLayers: [
    document.getElementById('native-layer-0'),
    document.getElementById('native-layer-1')
  ],
  loading: document.getElementById('loadingIndicator')
};

const bibleOverlayController = window.createBibleOverlayController({
  onReady: data => window.api.reportBibleOverlayReady(data),
  onReveal: data => {
    elements.container.classList.remove('cleared');
    window.api.reportBibleOverlayRevealed(data);
  },
  onHide: data => window.api.reportBibleOverlayHidden(data)
});

// Initialize display
function init() {
  // Listen for initialization from main process
  window.api.onDisplayInit(handleInit);
  
  // Listen for slide changes
  window.api.onSlideGoto(handleSlideGoto);

  // Listen for constrained live-DOM cue changes.
  window.api.onNativeCueGoto(handleNativeCueGoto);
  
  // Listen for clear command (black screen)
  window.api.onDisplayClear(handleClear);
  
  // Listen for fade duration changes
  window.api.onFadeUpdate(handleFadeUpdate);
  
  // Listen for sync mode changes
  window.api.onSyncModeUpdate(handleSyncModeUpdate);

  window.api.onBibleOverlayPrepare(data => bibleOverlayController.prepare(data));
  window.api.onBibleOverlayReveal(data => bibleOverlayController.reveal(data));
  window.api.onBibleOverlayHide(data => bibleOverlayController.hide(data));
  
  // Preload indicator
  elements.container.classList.add('loading');
  
  console.log('[Display] Initialized, waiting for configuration...');
}

function handleClear() {
  invalidateNavigation();
  bibleOverlayController.hide();
  elements.container.classList.add('cleared');

  // Show black screen by hiding all images
  elements.layers.forEach(layer => {
    if (layer) {
      layer.classList.remove('active');
      layer.src = '';
    }
  });
  clearNativeLayers();
  elements.noSlide.style.display = 'none';
  console.log('[Display] Screen cleared (black)');
}

function handleFadeUpdate(duration) {
  displayState.fadeDuration = duration;
  // Update CSS transition on both layers
  const transition = `opacity ${duration}ms ease-in-out`;
  elements.layers.forEach(layer => {
    if (layer) layer.style.transition = transition;
  });
  elements.nativeLayers.forEach(layer => {
    if (layer) layer.style.transition = transition;
  });
  console.log(`[Display] Fade duration set to ${duration}ms`);
}

function handleSyncModeUpdate(enabled) {
  displayState.syncMode = enabled;
  console.log(`[Display] Sync mode ${enabled ? 'enabled' : 'disabled'}`);
}

function handleInit(config) {
  displayState.language = config.language;
  displayState.outputName = config.outputName || config.language;
  displayState.renderer = config.renderer === 'native-cue' ? 'native-cue' : 'slides';
  displayState.displayId = config.displayId;
  displayState.isReady = true;
  displayState.fontReadiness = displayState.renderer === 'native-cue'
    ? preparePresentationFont(config.fontPath)
    : Promise.resolve({ ok: true });
  
  // Apply initial fade duration if provided
  if (config.fadeDuration !== undefined) {
    handleFadeUpdate(config.fadeDuration);
  }
  
  // Apply initial sync mode if provided
  if (config.syncMode !== undefined) {
    displayState.syncMode = config.syncMode;
  }
  
  elements.noSlide.textContent = `${displayState.outputName} Display Ready`;
  elements.container.classList.remove('loading');
  
  console.log(`[Display] Configured as ${config.language} display on monitor ${config.displayId}`);
}

async function preparePresentationFont(fontPath) {
  try {
    if (typeof fontPath !== 'string' || fontPath.length < 1 || fontPath.length > 4096) {
      throw new Error('The bundled presentation font path is invalid');
    }
    const fontUrl = window.pathUtils.toFileUrl(fontPath);
    if (typeof fontUrl !== 'string' || !fontUrl.startsWith('file:')) {
      throw new Error('The bundled presentation font URL is invalid');
    }
    const face = new FontFace(
      'SyncShow Noto Sans',
      `url("${fontUrl}") format("truetype")`,
      { display: 'block', style: 'normal', weight: '100 900' }
    );
    const loadedFace = await face.load();
    document.fonts.add(loadedFace);
    await document.fonts.ready;
    if (!document.fonts.check('16px "SyncShow Noto Sans"')) {
      throw new Error('The bundled presentation font did not become available');
    }
    return { ok: true };
  } catch (error) {
    console.error('[Display] Bundled presentation font failed to load:', error);
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'The bundled presentation font failed to load'
    };
  }
}

async function handleNativeCueGoto(data) {
  if (data?.outputId !== displayState.language) {
    console.warn(`[Display] Received native cue for ${data?.outputId}, but we are ${displayState.language}`);
    return;
  }
  if (displayState.renderer !== 'native-cue') {
    console.warn('[Display] Ignoring a native cue sent to a raster output');
    return;
  }

  const navigationVersion = invalidateNavigation();
  const index = data?.index;
  const nextLayerIndex = 1 - displayState.nativeActiveLayer;
  const nextLayer = elements.nativeLayers[nextLayerIndex];
  let candidate = null;

  try {
    if (!Number.isSafeInteger(index) || index < 0) {
      throw new Error('Native cue index is invalid');
    }
    const font = await displayState.fontReadiness;
    if (!isCurrentNavigation(navigationVersion)) return;
    if (!font.ok) throw new Error(font.error || 'The bundled presentation font is unavailable');

    const assetPaths = data?.assetPaths;
    if (!assetPaths || typeof assetPaths !== 'object' || Array.isArray(assetPaths)) {
      throw new Error('Native cue asset mapping is invalid');
    }
    const assetEntries = Object.entries(assetPaths);
    if (assetEntries.length > 4
      || assetEntries.some(([assetId, assetPath]) =>
        !/^sha256:[a-f0-9]{64}$/.test(assetId)
        || typeof assetPath !== 'string'
        || assetPath.length < 1
        || assetPath.length > 4096)) {
      throw new Error('Native cue asset mapping is invalid');
    }

    nextLayer.classList.remove('active');
    nextLayer.setAttribute('aria-hidden', 'true');
    nextLayer.replaceChildren();
    displayState.nativeRenderers[nextLayerIndex] = null;

    candidate = window.SyncShowNativeCueRenderer.buildScene(data?.scene, {
      resolveAssetUrl(assetId) {
        if (!Object.prototype.hasOwnProperty.call(assetPaths, assetId)) return null;
        const assetUrl = window.pathUtils.toFileUrl(assetPaths[assetId]);
        return typeof assetUrl === 'string' && assetUrl.startsWith('file:') ? assetUrl : null;
      }
    });
    nextLayer.appendChild(candidate.element);
    displayState.nativeRenderers[nextLayerIndex] = candidate;
    await candidate.prepare();
    await document.fonts.ready;
    candidate.relayout();
    if (!isCurrentNavigation(navigationVersion)) {
      if (nextLayer.firstElementChild === candidate.element) {
        nextLayer.replaceChildren();
        displayState.nativeRenderers[nextLayerIndex] = null;
      }
      return;
    }

    // The scene has decoded its assets, loaded the bundled font, completed two
    // layout frames, passed its fit checks, and reached an applied paint state.
    // ACK only after that barrier so main cannot reveal a still-black window.
    const didReveal = await swapToNativeCue(
      nextLayerIndex,
      data?.syncMode ? data?.revealAt : null,
      navigationVersion
    );
    if (!didReveal || !isCurrentNavigation(navigationVersion)) return;

    displayState.currentSlide = index;
    elements.noSlide.style.display = 'none';
    window.api.reportOutputFrameReady({ kind: 'native-cue', index, ok: true });
  } catch (error) {
    if (!isCurrentNavigation(navigationVersion)) return;
    if (candidate && nextLayer.firstElementChild === candidate.element) {
      nextLayer.replaceChildren();
      displayState.nativeRenderers[nextLayerIndex] = null;
    }
    const message = error instanceof Error ? error.message : 'Native cue could not be prepared';
    console.error(`[Display] Native cue ${Number.isSafeInteger(index) ? index + 1 : '?'} failed:`, error);
    window.api.reportOutputFrameReady({
      kind: 'native-cue',
      index: Number.isSafeInteger(index) ? index : -1,
      ok: false,
      error: message
    });
    showError(`Failed to prepare cue ${Number.isSafeInteger(index) ? index + 1 : ''}`.trim());
  }
}

async function handleSlideGoto(data) {
  const { index, timestamp, language, imagePath, preloadPaths, revealAt, syncMode } = data;
  
  // Verify this message is for us
  if (language !== displayState.language) {
    console.warn(`[Display] Received message for ${language}, but we are ${displayState.language}`);
    return;
  }
  if (displayState.renderer !== 'slides') {
    console.warn('[Display] Ignoring a raster cue sent to a native output');
    return;
  }

  // Every navigation supersedes all pending image work and reveal callbacks.
  // The version check also protects against callbacks that were already queued
  // when cancellation happened.
  const navigationVersion = invalidateNavigation();
  elements.container.classList.remove('cleared');
  
  // Calculate latency for debugging
  const latency = Date.now() - timestamp;
  if (latency > 50) {
    console.warn(`[Display] High latency detected: ${latency}ms`);
  }
  
  console.log(`[Display] Going to slide ${index + 1}, latency: ${latency}ms, syncMode: ${syncMode}`);
  
  // Hide "no slide" message
  elements.noSlide.style.display = 'none';
  
  // Load and display the current slide
  // In sync mode, we pass the revealAt timestamp so all displays reveal together
  const didScheduleSlide = await showSlide(
    imagePath,
    index,
    syncMode ? revealAt : null,
    navigationVersion
  );

  if (!didScheduleSlide || !isCurrentNavigation(navigationVersion)) {
    if (isCurrentNavigation(navigationVersion)) {
      window.api.reportOutputFrameReady({
        kind: 'display',
        index,
        ok: false,
        error: 'Slide image could not be loaded'
      });
    }
    return;
  }

  // Main keeps every output hidden until all windows report that their first
  // frame is prepared. Later reports are harmless when no startup waiter exists.
  window.api.reportOutputFrameReady({ kind: 'display', index, ok: true });
  
  // Preload adjacent slides in background
  preloadImage(preloadPaths?.prev, navigationVersion);
  preloadImage(preloadPaths?.next, navigationVersion);
  
  displayState.currentSlide = index;
}

async function showSlide(imagePath, index, revealAt, navigationVersion) {
  if (!imagePath) {
    if (isCurrentNavigation(navigationVersion)) {
      console.error('[Display] No image path provided');
    }
    return false;
  }
  
  const imageUrl = window.pathUtils.toFileUrl(imagePath);
  
  // Check if image is already cached
  if (displayState.imageCache.has(imagePath)) {
    // Instant switch using cached image
    return swapToImage(imageUrl, revealAt, navigationVersion);
  }
  
  // Load image
  try {
    const loaded = await loadImage(imageUrl, navigationVersion);
    if (!loaded || !isCurrentNavigation(navigationVersion)) return false;

    displayState.imageCache.set(imagePath, true);
    return swapToImage(imageUrl, revealAt, navigationVersion);
  } catch (error) {
    if (!isCurrentNavigation(navigationVersion)) return false;

    console.error('[Display] Failed to load image:', error);
    showError(`Failed to load slide ${index + 1}`);
    return false;
  }
}

async function swapToImage(imageUrl, revealAt, navigationVersion) {
  if (!isCurrentNavigation(navigationVersion)) return false;

  const currentLayer = displayState.activeLayer;
  const nextLayer = 1 - currentLayer;  // Toggle: 0->1 or 1->0
  
  const currentElement = elements.layers[currentLayer];
  const nextElement = elements.layers[nextLayer];
  const isInitialFrame = displayState.currentSlide < 0;
  
  // Set up the next layer with new image (hidden)
  nextElement.src = imageUrl;
  if (isInitialFrame) nextElement.style.transition = 'none';
  try {
    return await scheduleReveal(revealAt, navigationVersion, () => {
      // Fade in the new layer
      nextElement.classList.add('active');
      
      // Fade out the current layer
      currentElement.classList.remove('active');
      deactivateNativeLayers();
      elements.container.classList.remove('cleared');
      
      // Update which layer is active
      displayState.activeLayer = nextLayer;
    });
  } finally {
    if (isInitialFrame) {
      nextElement.style.transition = `opacity ${displayState.fadeDuration}ms ease-in-out`;
    }
  }
}

async function swapToNativeCue(layerIndex, revealAt, navigationVersion) {
  if (!isCurrentNavigation(navigationVersion)) return false;
  const nextLayer = elements.nativeLayers[layerIndex];
  const previousLayer = elements.nativeLayers[displayState.nativeActiveLayer];
  const isInitialFrame = displayState.currentSlide < 0;

  if (isInitialFrame) nextLayer.style.transition = 'none';
  try {
    return await scheduleReveal(revealAt, navigationVersion, () => {
      nextLayer.classList.add('active');
      nextLayer.setAttribute('aria-hidden', 'false');
      if (previousLayer !== nextLayer) {
        previousLayer.classList.remove('active');
        previousLayer.setAttribute('aria-hidden', 'true');
      }
      elements.layers.forEach(layer => layer?.classList.remove('active'));
      elements.container.classList.remove('cleared');
      displayState.nativeActiveLayer = layerIndex;
    });
  } finally {
    if (isInitialFrame) {
      nextLayer.style.transition = `opacity ${displayState.fadeDuration}ms ease-in-out`;
    }
  }
}

function scheduleReveal(revealAt, navigationVersion, applyReveal) {
  if (!isCurrentNavigation(navigationVersion)) return Promise.resolve(false);

  return new Promise(resolve => {
    const request = {
      settled: false,
      timer: null,
      frame: null,
      paintFrame: null,
      cancel() {
        if (request.settled) return;
        request.settled = true;
        if (request.timer) clearTimeout(request.timer);
        if (request.frame) cancelAnimationFrame(request.frame);
        if (request.paintFrame) cancelAnimationFrame(request.paintFrame);
        if (displayState.pendingReveal === request) displayState.pendingReveal = null;
        displayState.revealTimer = null;
        displayState.revealFrame = null;
        resolve(false);
      }
    };
    const finish = result => {
      if (request.settled) return;
      request.settled = true;
      if (displayState.pendingReveal === request) displayState.pendingReveal = null;
      displayState.revealTimer = null;
      displayState.revealFrame = null;
      resolve(result);
    };
    const applyInFrame = () => {
      if (!isCurrentNavigation(navigationVersion)) {
        finish(false);
        return;
      }
      request.frame = requestAnimationFrame(() => {
        request.frame = null;
        displayState.revealFrame = null;
        if (!isCurrentNavigation(navigationVersion)) {
          finish(false);
          return;
        }
        applyReveal();
        // Give Chromium one more paint opportunity after the active layer is
        // applied before main is allowed to expose a startup window.
        request.paintFrame = requestAnimationFrame(() => {
          request.paintFrame = null;
          finish(isCurrentNavigation(navigationVersion));
        });
        displayState.revealFrame = request.paintFrame;
      });
      displayState.revealFrame = request.frame;
    };

    displayState.pendingReveal = request;
    if (Number.isFinite(revealAt)) {
      const delay = revealAt - Date.now();
      if (delay > 0) {
        console.log(`[Display] Sync mode: waiting ${delay}ms to reveal`);
        request.timer = setTimeout(() => {
          request.timer = null;
          displayState.revealTimer = null;
          applyInFrame();
        }, delay);
        displayState.revealTimer = request.timer;
        return;
      }
      console.log(`[Display] Sync mode: reveal time passed (${-delay}ms ago), revealing now`);
    }
    applyInFrame();
  });
}

function deactivateNativeLayers() {
  elements.nativeLayers.forEach(layer => {
    if (!layer) return;
    layer.classList.remove('active');
    layer.setAttribute('aria-hidden', 'true');
  });
}

function clearNativeLayers() {
  deactivateNativeLayers();
  elements.nativeLayers.forEach(layer => layer?.replaceChildren());
  displayState.nativeRenderers = [null, null];
  displayState.nativeActiveLayer = 0;
}

function isCurrentNavigation(navigationVersion) {
  return navigationVersion === displayState.navigationVersion;
}

function cancelPendingReveal() {
  if (displayState.pendingReveal) {
    displayState.pendingReveal.cancel();
  } else {
    if (displayState.revealTimer) clearTimeout(displayState.revealTimer);
    if (displayState.revealFrame) cancelAnimationFrame(displayState.revealFrame);
  }
  displayState.pendingReveal = null;
  displayState.revealTimer = null;
  displayState.revealFrame = null;
}

function cancelPendingImageLoad() {
  if (displayState.pendingImageLoad) {
    displayState.pendingImageLoad.cancel();
    displayState.pendingImageLoad = null;
  }
}

function cancelPreloads() {
  [...displayState.preloadRequests].forEach(request => request.cancel());
  displayState.preloadRequests.clear();
}

function invalidateNavigation() {
  displayState.navigationVersion += 1;
  cancelPendingReveal();
  cancelPendingImageLoad();
  cancelPreloads();
  return displayState.navigationVersion;
}

function loadImage(url, navigationVersion) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    let settled = false;
    let request = null;

    const cleanup = () => {
      img.onload = null;
      img.onerror = null;
      if (displayState.pendingImageLoad === request) {
        displayState.pendingImageLoad = null;
      }
    };

    request = {
      cancel: () => {
        if (settled) return;
        settled = true;
        cleanup();
        img.src = '';
        resolve(false);
      }
    };

    displayState.pendingImageLoad = request;
    img.onload = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(isCurrentNavigation(navigationVersion));
    };
    img.onerror = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`Failed to load: ${url}`));
    };
    img.src = url;
  });
}

function preloadImage(imagePath, navigationVersion) {
  if (!imagePath || displayState.imageCache.has(imagePath)) return;
  
  const imageUrl = window.pathUtils.toFileUrl(imagePath);
  const img = new Image();
  let request = null;

  const cleanup = () => {
    img.onload = null;
    img.onerror = null;
    displayState.preloadRequests.delete(request);
  };

  request = {
    cancel: () => {
      cleanup();
      img.src = '';
    }
  };

  displayState.preloadRequests.add(request);
  img.onload = () => {
    cleanup();
    if (!isCurrentNavigation(navigationVersion)) return;

    displayState.imageCache.set(imagePath, true);
    console.log(`[Display] Preloaded: ${imagePath.split('/').pop()}`);
  };
  img.onerror = cleanup;
  img.src = imageUrl;
}

function showError(message) {
  elements.noSlide.textContent = message;
  elements.noSlide.style.display = 'flex';
  elements.noSlide.style.color = '#ff4444';
}

// Prevent right-click menu
document.addEventListener('contextmenu', (e) => e.preventDefault());

// Prevent keyboard shortcuts that might interfere
document.addEventListener('keydown', (e) => {
  // Allow Escape to be handled by main process
  if (e.key !== 'Escape') {
    e.preventDefault();
  }
});

window.addEventListener('resize', () => {
  if (displayState.renderer !== 'native-cue') return;
  if (displayState.revealFrame) return;
  displayState.revealFrame = requestAnimationFrame(() => {
    displayState.revealFrame = null;
    const active = displayState.nativeRenderers[displayState.nativeActiveLayer];
    if (!active) return;
    try {
      active.relayout();
    } catch (error) {
      console.error('[Display] Native cue could not be laid out after resize:', error);
      window.api.reportOutputFrameReady({
        kind: 'native-cue',
        index: displayState.currentSlide,
        ok: false,
        error: 'Native cue no longer fits the output'
      });
    }
  });
});

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', init);
