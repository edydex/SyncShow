/**
 * SyncDisplay - Presentation Display Window
 * Handles synchronized slide display with hardware-accelerated rendering
 */

// Display state
const displayState = {
  language: null,
  displayId: null,
  currentSlide: -1,
  imageCache: new Map(),
  isReady: false,
  fadeDuration: 300,
  activeLayer: 0,  // Toggle between 0 and 1 for crossfade
  syncMode: false  // Experimental: coordinate exact reveal timing
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
  loading: document.getElementById('loadingIndicator')
};

// Initialize display
function init() {
  // Listen for initialization from main process
  window.api.onDisplayInit(handleInit);
  
  // Listen for slide changes
  window.api.onSlideGoto(handleSlideGoto);
  
  // Listen for clear command (black screen)
  window.api.onDisplayClear(handleClear);
  
  // Listen for fade duration changes
  window.api.onFadeUpdate(handleFadeUpdate);
  
  // Listen for sync mode changes
  window.api.onSyncModeUpdate(handleSyncModeUpdate);
  
  // Preload indicator
  elements.container.classList.add('loading');
  
  console.log('[Display] Initialized, waiting for configuration...');
}

function handleClear() {
  // Show black screen by hiding all images
  elements.layers.forEach(layer => {
    if (layer) {
      layer.classList.remove('active');
      layer.src = '';
    }
  });
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
  console.log(`[Display] Fade duration set to ${duration}ms`);
}

function handleSyncModeUpdate(enabled) {
  displayState.syncMode = enabled;
  console.log(`[Display] Sync mode ${enabled ? 'enabled' : 'disabled'}`);
}

function handleInit(config) {
  displayState.language = config.language;
  displayState.displayId = config.displayId;
  displayState.isReady = true;
  
  // Apply initial fade duration if provided
  if (config.fadeDuration !== undefined) {
    handleFadeUpdate(config.fadeDuration);
  }
  
  // Apply initial sync mode if provided
  if (config.syncMode !== undefined) {
    displayState.syncMode = config.syncMode;
  }
  
  elements.noSlide.textContent = `${config.language.toUpperCase()} Display Ready`;
  elements.container.classList.remove('loading');
  
  console.log(`[Display] Configured as ${config.language} display on monitor ${config.displayId}`);
}

async function handleSlideGoto(data) {
  const { index, timestamp, language, imagePath, preloadPaths, revealAt, syncMode } = data;
  
  // Verify this message is for us
  if (language !== displayState.language) {
    console.warn(`[Display] Received message for ${language}, but we are ${displayState.language}`);
    return;
  }
  
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
  await showSlide(imagePath, index, syncMode ? revealAt : null);
  
  // Preload adjacent slides in background
  preloadImage(preloadPaths.prev);
  preloadImage(preloadPaths.next);
  
  displayState.currentSlide = index;
}

async function showSlide(imagePath, index, revealAt = null) {
  if (!imagePath) {
    console.error('[Display] No image path provided');
    return;
  }
  
  const imageUrl = window.pathUtils.toFileUrl(imagePath);
  
  // Check if image is already cached
  if (displayState.imageCache.has(imagePath)) {
    // Instant switch using cached image
    swapToImage(imageUrl, revealAt);
    return;
  }
  
  // Load image
  try {
    await loadImage(imageUrl);
    displayState.imageCache.set(imagePath, true);
    swapToImage(imageUrl, revealAt);
  } catch (error) {
    console.error('[Display] Failed to load image:', error);
    showError(`Failed to load slide ${index + 1}`);
  }
}

function swapToImage(imageUrl, revealAt = null) {
  const currentLayer = displayState.activeLayer;
  const nextLayer = 1 - currentLayer;  // Toggle: 0->1 or 1->0
  
  const currentElement = elements.layers[currentLayer];
  const nextElement = elements.layers[nextLayer];
  
  // Set up the next layer with new image (hidden)
  nextElement.src = imageUrl;
  
  // Function to perform the actual crossfade
  const doReveal = () => {
    requestAnimationFrame(() => {
      // Fade in the new layer
      nextElement.classList.add('active');
      
      // Fade out the current layer
      currentElement.classList.remove('active');
      
      // Update which layer is active
      displayState.activeLayer = nextLayer;
    });
  };
  
  // If we have a target reveal time (sync mode), wait until that moment
  if (revealAt) {
    const now = Date.now();
    const delay = revealAt - now;
    
    if (delay > 0) {
      // Wait until the target time, then reveal
      console.log(`[Display] Sync mode: waiting ${delay}ms to reveal`);
      setTimeout(doReveal, delay);
    } else {
      // Target time already passed, reveal immediately
      console.log(`[Display] Sync mode: reveal time passed (${-delay}ms ago), revealing now`);
      doReveal();
    }
  } else {
    // No sync mode, reveal immediately
    doReveal();
  }
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load: ${url}`));
    img.src = url;
  });
}

function preloadImage(imagePath) {
  if (!imagePath || displayState.imageCache.has(imagePath)) return;
  
  const imageUrl = window.pathUtils.toFileUrl(imagePath);
  const img = new Image();
  img.onload = () => {
    displayState.imageCache.set(imagePath, true);
    console.log(`[Display] Preloaded: ${imagePath.split('/').pop()}`);
  };
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

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', init);
