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

// Initialize
function init() {
  if (!window.api || !window.api.onSingerUpdate || !window.pathUtils) {
    console.error('[Singer] API not available');
    return;
  }
  
  window.api.onSingerUpdate(handleUpdate);
  window.api.onDisplayClear(handleClear);
  console.log('[Singer] Initialized');
}

function handleClear() {
  elements.container.classList.add('cleared');
}

function handleUpdate(data) {
  if (!data) return;
  
  const { currentSlide, currentSlideImage, nextSlideText, totalSlides } = data;
  
  // Remove cleared state if it was set
  elements.container.classList.remove('cleared');
  
  // Update current slide image
  if (currentSlideImage) {
    const imageUrl = window.pathUtils.toFileUrl(currentSlideImage);
    
    if (!currentImage || currentImage.src !== imageUrl) {
      const img = document.createElement('img');
      img.src = imageUrl;
      img.alt = `Slide ${currentSlide}`;
      img.onload = () => {
        elements.currentSlideContainer.innerHTML = '';
        elements.currentSlideContainer.appendChild(img);
        currentImage = img;
      };
      img.onerror = () => {
        elements.currentSlideContainer.innerHTML = '<div class="waiting">Failed to load slide</div>';
      };
    }
  } else {
    elements.currentSlideContainer.innerHTML = '<div class="waiting">No slide image</div>';
  }
  
  // Update next slide preview
  if (currentSlide >= totalSlides) {
    elements.nextText.innerHTML = '<div class="end-slide">End of Presentation</div>';
  } else if (nextSlideText && nextSlideText.trim()) {
    const displayText = getFirstMeaningfulLine(nextSlideText);
    elements.nextText.textContent = displayText;
    
    // Adjust font size based on text length
    elements.nextText.classList.remove('small', 'very-small');
    if (displayText.length > 100) {
      elements.nextText.classList.add('very-small');
    } else if (displayText.length > 50) {
      elements.nextText.classList.add('small');
    }
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
