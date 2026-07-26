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
let updateVersion = 0;
let pendingImage = null;
let isCleared = false;
const bibleOverlayController = window.createBibleOverlayController({
  onReady: data => window.api.reportBibleOverlayReady(data),
  onReveal: data => {
    isCleared = false;
    elements.container.classList.remove('cleared');
    window.api.reportBibleOverlayRevealed(data);
  },
  onHide: data => window.api.reportBibleOverlayHidden(data)
});

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
  window.api.onBibleOverlayPrepare(data => bibleOverlayController.prepare(data));
  window.api.onBibleOverlayReveal(data => bibleOverlayController.reveal(data));
  window.api.onBibleOverlayHide(data => bibleOverlayController.hide(data));
  console.log('[Singer] Initialized');
}

function handleFontSize(size) {
  baseFontSize = size;
  applyFontSize();
}

function handleCharLimit(limit) {
  charLimit = limit;
  if (lastUpdateData) handleUpdate(lastUpdateData, true);
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
  invalidatePendingImage();
  bibleOverlayController.hide();
  isCleared = true;
  elements.container.classList.add('cleared');
}

function handleUpdate(data, preserveClearedState = false) {
  if (!data) return;
  const thisUpdateVersion = invalidatePendingImage();
  lastUpdateData = data;
  let reportSynchronously = false;
  let synchronousReportOk = true;
  
  const { currentSlide, currentSlideImage, nextSlideText, totalSlides } = data;
  
  // A real slide update restores the singer output. Setting-only rerenders
  // preserve a prior Clear so they cannot resurrect stale content.
  if (!preserveClearedState) {
    isCleared = false;
  }
  elements.container.classList.toggle('cleared', isCleared);
  
  // Update current slide image
  if (currentSlideImage) {
    const imageUrl = window.pathUtils.toFileUrl(currentSlideImage);
    
    if (!currentImage || currentImage.src !== imageUrl) {
      const img = document.createElement('img');
      img.alt = `Slide ${currentSlide}`;
      // Keep the candidate image in the document while it loads. Chromium can
      // defer detached image work for a hidden BrowserWindow, which would
      // deadlock SyncShow's intentional first-frame-before-reveal barrier.
      // The previous image remains visible until this hidden candidate is
      // fully decoded.
      img.hidden = true;
      pendingImage = img;
      img.onload = () => {
        if (thisUpdateVersion !== updateVersion || pendingImage !== img) return;

        pendingImage = null;
        img.hidden = false;
        elements.currentSlideContainer.replaceChildren(img);
        currentImage = img;
        console.log(`[Singer] Slide ${currentSlide} image loaded; reporting frame ready`);
        reportFrameReady(currentSlide, true);
      };
      img.onerror = () => {
        if (thisUpdateVersion !== updateVersion || pendingImage !== img) return;

        pendingImage = null;
        currentImage = null;
        elements.currentSlideContainer.innerHTML = '<div class="waiting">Failed to load slide</div>';
        console.error(`[Singer] Slide ${currentSlide} image failed to load: ${imageUrl}`);
        reportFrameReady(currentSlide, false, 'Slide image could not be loaded');
      };
      elements.currentSlideContainer.appendChild(img);
      img.src = imageUrl;
    } else {
      reportSynchronously = true;
    }
  } else {
    currentImage = null;
    elements.currentSlideContainer.innerHTML = '<div class="waiting">No slide image</div>';
    reportSynchronously = true;
    synchronousReportOk = false;
  }
  
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

  if (reportSynchronously) {
    reportFrameReady(
      currentSlide,
      synchronousReportOk,
      synchronousReportOk ? null : 'No slide image was available'
    );
  }
}

function reportFrameReady(currentSlide, ok, error = null) {
  window.api.reportOutputFrameReady({
    kind: 'singer',
    index: Math.max(0, currentSlide - 1),
    ok,
    error
  });
}

function invalidatePendingImage() {
  updateVersion += 1;

  if (pendingImage) {
    pendingImage.onload = null;
    pendingImage.onerror = null;
    pendingImage.src = '';
    pendingImage.remove();
    pendingImage = null;
  }

  return updateVersion;
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
