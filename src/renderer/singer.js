/**
 * SyncShow - Singer Screen
 * Shows current slide image + preview of next slide text
 */

// DOM Elements
const elements = {
  container: document.getElementById('singerContainer'),
  currentSlideContainer: document.getElementById('currentSlideContainer'),
  nextText: document.getElementById('nextText')
};

let currentImage = null;
let baseFontSize = 36;
let charLimit = 70;
let textPadding = 4;
let lastUpdateData = null;
let currentMode = 'auto-preview';

// Initialize
function init() {
  if (!window.api || !window.api.onSingerUpdate || !window.pathUtils) {
    console.error('[Singer] API not available');
    return;
  }

  window.api.onSingerUpdate(handleUpdate);
  window.api.onDisplayClear(handleClear);
  window.api.onSingerFontSize(handleFontSize);
  window.api.onSingerCharLimit(handleCharLimit);
  window.api.onSingerTextPadding(handleTextPadding);
  if (window.api.onSingerModeUpdate) {
    window.api.onSingerModeUpdate(handleModeUpdate);
  }
  console.log('[Singer] Initialized');
}

function handleFontSize(size) {
  baseFontSize = size;
  applyFontSize();
}

function handleCharLimit(limit) {
  charLimit = limit;
  if (lastUpdateData) handleUpdate(lastUpdateData);
}

function handleTextPadding(padding) {
  textPadding = padding;
  elements.nextText.style.padding = `${padding}px 30px`;
}

function applyFontSize() {
  const el = elements.nextText;
  if (el.classList.contains('very-small')) {
    el.style.fontSize = `${Math.round(baseFontSize * 0.61)}px`;
  } else if (el.classList.contains('small')) {
    el.style.fontSize = `${Math.round(baseFontSize * 0.78)}px`;
  } else {
    el.style.fontSize = `${baseFontSize}px`;
  }
}

function handleClear() {
  elements.container.classList.add('cleared');
}

function handleModeUpdate(mode) {
  currentMode = mode === 'third-pptx' ? 'third-pptx' : 'auto-preview';
  if (currentMode === 'third-pptx') {
    elements.container.classList.add('mode-b');
  } else {
    elements.container.classList.remove('mode-b');
  }
  // Re-render the last update under the new mode
  if (lastUpdateData) handleUpdate(lastUpdateData);
}

function renderImage(imagePath, slideNum, fallbackHTML) {
  if (imagePath) {
    const imageUrl = window.pathUtils.toFileUrl(imagePath);
    if (!currentImage || currentImage.src !== imageUrl) {
      const img = document.createElement('img');
      img.src = imageUrl;
      img.alt = `Slide ${slideNum}`;
      img.onload = () => {
        elements.currentSlideContainer.innerHTML = '';
        elements.currentSlideContainer.appendChild(img);
        currentImage = img;
      };
      img.onerror = () => {
        elements.currentSlideContainer.innerHTML = fallbackHTML;
        currentImage = null;
      };
    }
  } else {
    elements.currentSlideContainer.innerHTML = fallbackHTML;
    currentImage = null;
  }
}

function handleUpdate(data) {
  if (!data) return;
  lastUpdateData = data;

  const { currentSlide, currentSlideImage, nextSlideText, totalSlides, mode } = data;
  const effectiveMode = mode || currentMode;

  // Remove cleared state if it was set
  elements.container.classList.remove('cleared');

  // Keep the body class in sync with the mode field of the latest update
  if (effectiveMode === 'third-pptx') {
    elements.container.classList.add('mode-b');
  } else {
    elements.container.classList.remove('mode-b');
  }
  currentMode = effectiveMode;

  if (effectiveMode === 'third-pptx') {
    // Mode B: full-screen third-pptx image. Out of range -> silent black.
    renderImage(currentSlideImage, currentSlide, '');
    return;
  }

  // Mode A (default): current slide image + next slide text preview
  renderImage(currentSlideImage, currentSlide, '<div class="waiting">No slide image</div>');

  // Update next slide preview
  if (currentSlide >= totalSlides) {
    elements.nextText.innerHTML = '<div class="end-slide">End of Presentation</div>';
  } else if (nextSlideText && nextSlideText.trim()) {
    const rawText = getFirstMeaningfulLine(nextSlideText);
    const displayText = rawText.length > charLimit ? rawText.substring(0, charLimit) + '…' : rawText;
    elements.nextText.textContent = displayText;

    // Adjust font size based on text length
    elements.nextText.classList.remove('small', 'very-small');
    if (displayText.length > 100) {
      elements.nextText.classList.add('very-small');
    } else if (displayText.length > 50) {
      elements.nextText.classList.add('small');
    }
    applyFontSize();
  } else {
    elements.nextText.innerHTML = '<div class="waiting"></div>';
  }
}

function getFirstMeaningfulLine(text) {
  // Split into lines and find first meaningful one
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  
  for (const line of lines) {
    // Skip very short lines (likely numbers or bullets)
    if (line.length > 2) {
      // Limit length for display
      if (line.length > 200) {
        return line.substring(0, 197) + '...';
      }
      return line;
    }
  }
  
  return text.substring(0, 200);
}

// Prevent interactions
document.addEventListener('contextmenu', e => e.preventDefault());

// Initialize - call immediately if DOM already ready, otherwise wait
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  // DOM already loaded, call init directly
  init();
}
