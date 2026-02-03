/**
 * SyncDisplay Control Panel - Main Application Logic
 */

// Application State
const state = {
  presentations: {
    russian: { loaded: false, path: null, slides: [] },
    english: { loaded: false, path: null, slides: [] }
  },
  currentSlide: 0,
  totalSlides: 0,
  displays: [],
  isPresenting: false,
  thumbnailLang: 'both'  // 'both', 'russian', or 'english'
};

// DOM Elements
const elements = {
  // File inputs
  russianFilePath: document.getElementById('russianFilePath'),
  englishFilePath: document.getElementById('englishFilePath'),
  btnSelectRussian: document.getElementById('btnSelectRussian'),
  btnSelectEnglish: document.getElementById('btnSelectEnglish'),
  
  // Status indicators
  russianStatus: document.getElementById('russianStatus'),
  englishStatus: document.getElementById('englishStatus'),
  russianProgress: document.getElementById('russianProgress'),
  englishProgress: document.getElementById('englishProgress'),
  
  // Display selectors
  russianDisplay: document.getElementById('russianDisplay'),
  englishDisplay: document.getElementById('englishDisplay'),
  singerDisplay: document.getElementById('singerDisplay'),
  singerLanguage: document.getElementById('singerLanguage'),
  fadeDuration: document.getElementById('fadeDuration'),
  syncMode: document.getElementById('syncMode'),
  
  // Control buttons
  btnRefreshDisplays: document.getElementById('btnRefreshDisplays'),
  btnStartPresentation: document.getElementById('btnStartPresentation'),
  btnShowDisplays: document.getElementById('btnShowDisplays'),
  btnClearDisplays: document.getElementById('btnClearDisplays'),
  btnStopDisplays: document.getElementById('btnStopDisplays'),
  btnBackToSetup: document.getElementById('btnBackToSetup'),
  btnPrevSlide: document.getElementById('btnPrevSlide'),
  btnNextSlide: document.getElementById('btnNextSlide'),
  
  // Panels
  setupPanel: document.getElementById('setupPanel'),
  mainContent: document.getElementById('mainContent'),
  setupHeader: document.getElementById('setupHeader'),
  
  // Slide displays
  currentSlideNum: document.getElementById('currentSlideNum'),
  totalSlides: document.getElementById('totalSlides'),
  currentRussianImg: document.getElementById('currentRussianImg'),
  currentEnglishImg: document.getElementById('currentEnglishImg'),
  thumbnailsGrid: document.getElementById('thumbnailsGrid'),
  
  // Status bar
  statusMessage: document.getElementById('statusMessage')
};

// Initialize the application
async function init() {
  setupEventListeners();
  await loadAppState();
  
  // Set up IPC listeners
  window.api.onDisplaysUpdated(handleDisplaysUpdated);
  window.api.onConversionProgress(handleConversionProgress);
  window.api.onSlideChanged(handleSlideChanged);
  
  setStatus('Ready - Select PowerPoint files to begin');
}

function setupEventListeners() {
  // File selection
  elements.btnSelectRussian.addEventListener('click', () => selectFile('russian'));
  elements.btnSelectEnglish.addEventListener('click', () => selectFile('english'));
  
  // Display controls
  elements.btnRefreshDisplays.addEventListener('click', refreshDisplays);
  elements.btnStartPresentation.addEventListener('click', startPresentation);
  elements.btnShowDisplays.addEventListener('click', showDisplays);
  elements.btnClearDisplays.addEventListener('click', clearDisplays);
  elements.btnStopDisplays.addEventListener('click', stopDisplays);
  elements.btnBackToSetup.addEventListener('click', backToSetup);
  
  // Fade duration change (can be changed while presenting)
  elements.fadeDuration.addEventListener('change', handleFadeDurationChange);
  
  // Sync mode toggle (can be changed while presenting)
  elements.syncMode.addEventListener('change', handleSyncModeChange);
  
  // Navigation
  elements.btnPrevSlide.addEventListener('click', () => navigateSlide(-1));
  elements.btnNextSlide.addEventListener('click', () => navigateSlide(1));
  
  // Keyboard shortcuts (as backup for global shortcuts)
  document.addEventListener('keydown', handleKeyboard);
  
  // Language filter buttons for thumbnails
  document.querySelectorAll('.lang-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      // Update active state
      document.querySelectorAll('.lang-btn').forEach(b => b.classList.remove('active'));
      e.target.classList.add('active');
      
      // Update state and re-render
      state.thumbnailLang = e.target.dataset.lang;
      renderThumbnails();
    });
  });
  
  // View controls (grid/list)
  document.querySelectorAll('.view-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      document.querySelectorAll('.view-btn').forEach(b => b.classList.remove('active'));
      e.target.classList.add('active');
      // Could implement different view modes here
    });
  });
}

async function loadAppState() {
  try {
    const appState = await window.api.getAppState();
    state.currentSlide = appState.currentSlide;
    state.totalSlides = appState.totalSlides;
    state.displays = appState.displays;
    
    updateDisplayDropdowns();
    
    // Load saved user settings (display assignments, etc.)
    await loadSavedSettings();
    
    // Check for cached presentations from previous session
    await checkForCachedPresentations();
  } catch (error) {
    console.error('Failed to load app state:', error);
  }
}

// Load saved user settings
async function loadSavedSettings() {
  try {
    const settings = await window.api.loadSettings();
    
    // Apply saved display assignments after displays are loaded
    if (settings.displayAssignments) {
      setTimeout(() => {
        if (settings.displayAssignments.russian && elements.russianDisplay) {
          elements.russianDisplay.value = settings.displayAssignments.russian;
        }
        if (settings.displayAssignments.english && elements.englishDisplay) {
          elements.englishDisplay.value = settings.displayAssignments.english;
        }
        if (settings.displayAssignments.singer && elements.singerDisplay) {
          elements.singerDisplay.value = settings.displayAssignments.singer;
        }
        if (settings.singerLanguage && elements.singerLanguage) {
          elements.singerLanguage.value = settings.singerLanguage;
        }
        if (settings.fadeDuration !== undefined && elements.fadeDuration) {
          elements.fadeDuration.value = settings.fadeDuration.toString();
        }
        if (settings.syncMode !== undefined && elements.syncMode) {
          elements.syncMode.checked = settings.syncMode;
        }
      }, 100); // Small delay to ensure dropdowns are populated
    }
    
    console.log('[Settings] Loaded saved settings:', settings);
  } catch (error) {
    console.error('Failed to load saved settings:', error);
  }
}

// Save current settings
async function saveCurrentSettings() {
  try {
    const settings = {
      displayAssignments: {
        russian: elements.russianDisplay.value || null,
        english: elements.englishDisplay.value || null,
        singer: elements.singerDisplay.value || null
      },
      singerLanguage: elements.singerLanguage.value || 'russian',
      fadeDuration: parseInt(elements.fadeDuration.value) || 300,
      syncMode: elements.syncMode.checked || false
    };
    
    await window.api.saveSettings(settings);
    console.log('[Settings] Saved settings:', settings);
  } catch (error) {
    console.error('Failed to save settings:', error);
  }
}

// Check for cached presentations from previous session
async function checkForCachedPresentations() {
  try {
    const [russianCache, englishCache] = await Promise.all([
      window.api.checkCache('russian'),
      window.api.checkCache('english')
    ]);
    
    // If both caches exist, offer to restore them
    if (russianCache.exists && englishCache.exists) {
      setStatus(`Previous presentation found (${russianCache.slideCount} slides). Click "Restore Previous" to load it.`);
      showRestoreButton(russianCache, englishCache);
    } else if (russianCache.exists || englishCache.exists) {
      const lang = russianCache.exists ? 'Russian' : 'English';
      const cache = russianCache.exists ? russianCache : englishCache;
      setStatus(`Previous ${lang} presentation found (${cache.slideCount} slides).`);
    }
  } catch (error) {
    console.error('Failed to check for cached presentations:', error);
  }
}

// Show restore button for previous presentation
function showRestoreButton(russianCache, englishCache) {
  // Check if restore button already exists
  if (document.getElementById('btnRestorePrevious')) return;
  
  // Create restore button
  const restoreBtn = document.createElement('button');
  restoreBtn.id = 'btnRestorePrevious';
  restoreBtn.className = 'btn btn-secondary';
  restoreBtn.textContent = 'Restore Previous';
  restoreBtn.title = `Restore previous presentation (Russian: ${russianCache.slideCount} slides, English: ${englishCache.slideCount} slides)`;
  restoreBtn.style.marginLeft = '10px';
  
  restoreBtn.addEventListener('click', async () => {
    await restorePreviousPresentation(russianCache, englishCache);
    restoreBtn.remove();
  });
  
  // Add button next to Start button
  const startBtn = elements.btnStartPresentation;
  startBtn.parentNode.insertBefore(restoreBtn, startBtn.nextSibling);
}

// Restore previous presentation from cache
async function restorePreviousPresentation(russianCache, englishCache) {
  try {
    setStatus('Restoring previous presentation...');
    
    // Load Russian from cache
    if (russianCache.exists) {
      const result = await window.api.loadFromCache('russian');
      if (result.success) {
        state.presentations.russian = {
          loaded: true,
          path: russianCache.originalFile || 'Cached',
          slideCount: result.slideCount,
          cacheDir: result.cacheDir
        };
        
        elements.russianFilePath.value = russianCache.originalFile || '[Cached presentation]';
        updateConversionStatus('russian', `Restored: ${result.slideCount} slides`, false);
        await loadSlideList('russian');
      }
    }
    
    // Load English from cache
    if (englishCache.exists) {
      const result = await window.api.loadFromCache('english');
      if (result.success) {
        state.presentations.english = {
          loaded: true,
          path: englishCache.originalFile || 'Cached',
          slideCount: result.slideCount,
          cacheDir: result.cacheDir
        };
        
        elements.englishFilePath.value = englishCache.originalFile || '[Cached presentation]';
        updateConversionStatus('english', `Restored: ${result.slideCount} slides`, false);
        await loadSlideList('english');
      }
    }
    
    checkReadyState();
    setStatus('Previous presentation restored successfully');
  } catch (error) {
    console.error('Failed to restore previous presentation:', error);
    setStatus('Error restoring previous presentation');
  }
}

// File Selection and Conversion
async function selectFile(language) {
  try {
    const filePath = await window.api.openPptxDialog(language);
    if (!filePath) return;
    
    const pathInput = language === 'russian' ? elements.russianFilePath : elements.englishFilePath;
    pathInput.value = filePath;
    
    setStatus(`Converting ${language} presentation...`);
    updateConversionStatus(language, 'Converting...', true);
    
    const result = await window.api.convertPptx(filePath, language);
    
    if (result.success) {
      state.presentations[language] = {
        loaded: true,
        path: filePath,
        slideCount: result.slideCount,
        cacheDir: result.cacheDir
      };
      
      updateConversionStatus(language, `✓ ${result.slideCount} slides loaded`, false);
      setStatus(`${language.charAt(0).toUpperCase() + language.slice(1)} presentation loaded successfully`);
      
      // Load slide list
      await loadSlideList(language);
      
      checkReadyState();
    }
  } catch (error) {
    console.error(`Error loading ${language} file:`, error);
    updateConversionStatus(language, `✗ Error: ${error.message}`, false);
    setStatus(`Error loading ${language} presentation`);
  }
}

function updateConversionStatus(language, message, showProgress) {
  const statusEl = language === 'russian' ? elements.russianStatus : elements.englishStatus;
  const progressBar = statusEl.querySelector('.progress-bar');
  const statusText = statusEl.querySelector('.status-text');
  
  statusText.textContent = message;
  statusText.className = 'status-text';
  
  if (message.startsWith('✓')) {
    statusText.classList.add('success');
  } else if (message.startsWith('✗')) {
    statusText.classList.add('error');
  }
  
  progressBar.style.display = showProgress ? 'block' : 'none';
}

function handleConversionProgress({ language, progress }) {
  const progressEl = language === 'russian' ? elements.russianProgress : elements.englishProgress;
  progressEl.style.width = `${progress}%`;
}

async function loadSlideList(language) {
  try {
    const slides = await window.api.getSlideList(language);
    console.log(`[loadSlideList] Loaded ${slides.length} slides for ${language}`);
    if (slides[0]) {
      console.log(`[loadSlideList] First slide keys:`, Object.keys(slides[0]));
      console.log(`[loadSlideList] Has thumbnailBase64:`, !!slides[0].thumbnailBase64);
      console.log(`[loadSlideList] thumbnailBase64 length:`, slides[0].thumbnailBase64?.length || 0);
    }
    state.presentations[language].slides = slides;
    
    // Render thumbnails whenever we load slides (even if only one language)
    renderThumbnails();
  } catch (error) {
    console.error(`Error loading slide list for ${language}:`, error);
  }
}

// Display Management
function handleDisplaysUpdated(displays) {
  state.displays = displays;
  updateDisplayDropdowns();
}

async function refreshDisplays() {
  try {
    const displays = await window.api.refreshDisplays();
    state.displays = displays;
    updateDisplayDropdowns();
    setStatus(`Found ${displays.length} displays`);
  } catch (error) {
    console.error('Error refreshing displays:', error);
    setStatus('Error detecting displays');
  }
}

function updateDisplayDropdowns() {
  const displays = state.displays;
  
  [elements.russianDisplay, elements.englishDisplay, elements.singerDisplay].forEach((dropdown, index) => {
    const currentValue = dropdown.value;
    
    // Clear existing options (except first)
    while (dropdown.options.length > 1) {
      dropdown.remove(1);
    }
    
    // Add display options
    displays.forEach(display => {
      const option = document.createElement('option');
      option.value = display.id;
      option.textContent = display.label;
      dropdown.appendChild(option);
    });
    
    // Restore selection if still valid
    if (currentValue) {
      dropdown.value = currentValue;
    }
    
    // Auto-select if possible
    if (!dropdown.value && displays.length > index) {
      // Skip primary display for presentation windows
      const nonPrimaryDisplays = displays.filter(d => !d.isPrimary);
      if (index < 2 && nonPrimaryDisplays.length > index) {
        dropdown.value = nonPrimaryDisplays[index].id;
      }
    }
  });
}

// Presentation Control
function checkReadyState() {
  const russianReady = state.presentations.russian.loaded;
  const englishReady = state.presentations.english.loaded;
  const russianDisplay = elements.russianDisplay.value;
  const englishDisplay = elements.englishDisplay.value;
  
  const isReady = russianReady && englishReady && russianDisplay && englishDisplay;
  elements.btnStartPresentation.disabled = !isReady;
  
  if (isReady) {
    setStatus('Ready to start presentation');
  }
}

async function startPresentation() {
  try {
    const displays = {
      russianDisplayId: parseInt(elements.russianDisplay.value) || 0,
      englishDisplayId: parseInt(elements.englishDisplay.value) || 1,
      singerDisplayId: elements.singerDisplay.value ? parseInt(elements.singerDisplay.value) : null,
      singerLanguage: elements.singerLanguage.value || 'russian',
      fadeDuration: parseInt(elements.fadeDuration.value) || 300,
      syncMode: elements.syncMode.checked || false
    };
    
    // Save settings before starting
    await saveCurrentSettings();
    
    setStatus('Starting presentation...');
    
    const result = await window.api.startPresentation(displays);
    
    if (result.success) {
      state.isPresenting = true;
      state.totalSlides = result.totalSlides;
      
      // Update UI - hide setup, show main content
      elements.btnStartPresentation.style.display = 'none';
      elements.setupPanel.style.display = 'none';
      elements.setupHeader.style.display = 'none';
      elements.mainContent.style.display = 'flex';
      
      // Ensure slides are loaded and render thumbnails
      await loadSlidesIfNeeded();
      renderThumbnails();
      
      updateSlideCounter();
      updateCurrentSlidePreview();
      setStatus('Presentation started');
    }
  } catch (error) {
    console.error('Error starting presentation:', error);
    setStatus(`Error: ${error.message}`);
  }
}

// Helper to ensure slides are loaded
async function loadSlidesIfNeeded() {
  if (state.presentations.russian.loaded && state.presentations.russian.slides.length === 0) {
    await loadSlideList('russian');
  }
  if (state.presentations.english.loaded && state.presentations.english.slides.length === 0) {
    await loadSlideList('english');
  }
}

// Show displays - re-show the display windows and current slide
async function showDisplays() {
  try {
    await window.api.showDisplays();
    setStatus('Displays shown');
  } catch (error) {
    console.error('Error showing displays:', error);
  }
}

// Clear displays - show black screens
async function clearDisplays() {
  try {
    await window.api.clearDisplays();
    setStatus('Displays cleared (black screens)');
  } catch (error) {
    console.error('Error clearing displays:', error);
  }
}

// Handle fade duration change
async function handleFadeDurationChange() {
  const duration = parseInt(elements.fadeDuration.value) || 0;
  try {
    await window.api.setFadeDuration(duration);
    await saveCurrentSettings();
    if (duration === 0) {
      setStatus('Transitions: Instant');
    } else {
      setStatus(`Transitions: ${duration}ms fade`);
    }
  } catch (error) {
    console.error('Error setting fade duration:', error);
  }
}

// Handle sync mode toggle
async function handleSyncModeChange() {
  const enabled = elements.syncMode.checked;
  try {
    await window.api.setSyncMode(enabled);
    await saveCurrentSettings();
    if (enabled) {
      setStatus('Experimental Sync: Enabled - displays will coordinate timing');
    } else {
      setStatus('Experimental Sync: Disabled');
    }
  } catch (error) {
    console.error('Error setting sync mode:', error);
  }
}

// Stop displays - hide windows and unregister keyboard shortcuts
async function stopDisplays() {
  try {
    await window.api.stopPresentation();
    setStatus('Presentation stopped - keyboard shortcuts disabled');
  } catch (error) {
    console.error('Error stopping displays:', error);
  }
}

// Back to setup - stop presentation and go back to setup screen
async function backToSetup() {
  try {
    await window.api.stopPresentation();
    
    state.isPresenting = false;
    
    // Update UI - show setup, hide main content
    elements.btnStartPresentation.style.display = 'inline-flex';
    elements.setupPanel.style.display = 'block';
    elements.setupHeader.style.display = 'flex';
    elements.mainContent.style.display = 'none';
    
    setStatus('Returned to setup');
  } catch (error) {
    console.error('Error returning to setup:', error);
  }
}

// Slide Navigation
function navigateSlide(delta) {
  const newSlide = state.currentSlide + delta;
  if (newSlide >= 0 && newSlide < state.totalSlides) {
    goToSlide(newSlide);
  }
}

function goToSlide(slideIndex) {
  if (slideIndex < 0 || slideIndex >= state.totalSlides) return;
  
  window.api.navigateToSlide(slideIndex);
}

function handleSlideChanged({ currentSlide, totalSlides }) {
  state.currentSlide = currentSlide;
  state.totalSlides = totalSlides;
  
  updateSlideCounter();
  updateCurrentSlidePreview();
  updateThumbnailHighlight();
}

function updateSlideCounter() {
  elements.currentSlideNum.textContent = state.currentSlide + 1;
  elements.totalSlides.textContent = state.totalSlides;
}

function updateCurrentSlidePreview() {
  const russianSlide = state.presentations.russian.slides[state.currentSlide];
  const englishSlide = state.presentations.english.slides[state.currentSlide];
  
  if (russianSlide) {
    elements.currentRussianImg.src = window.pathUtils.toFileUrl(russianSlide.imagePath);
  }
  
  if (englishSlide) {
    elements.currentEnglishImg.src = window.pathUtils.toFileUrl(englishSlide.imagePath);
  }
}

function updateThumbnailHighlight() {
  document.querySelectorAll('.thumbnail-item').forEach((item, index) => {
    item.classList.toggle('active', index === state.currentSlide);
  });
  
  // Scroll active thumbnail into view - scroll earlier when in lower third of viewport
  const activeThumb = document.querySelector('.thumbnail-item.active');
  const grid = elements.thumbnailsGrid;
  
  if (activeThumb && grid) {
    const gridRect = grid.getBoundingClientRect();
    const thumbRect = activeThumb.getBoundingClientRect();
    
    // Check if thumbnail is in the lower 40% of the visible grid area
    const lowerThreshold = gridRect.top + gridRect.height * 0.6;
    const upperThreshold = gridRect.top + gridRect.height * 0.2;
    
    // If thumbnail is below the lower threshold OR above the upper threshold, scroll to center it
    if (thumbRect.top > lowerThreshold || thumbRect.bottom < upperThreshold) {
      const scrollOffset = activeThumb.offsetTop - (grid.offsetHeight / 2) + (activeThumb.offsetHeight / 2);
      grid.scrollTo({
        top: Math.max(0, scrollOffset),
        behavior: 'smooth'
      });
    }
  }
}

// Thumbnail Rendering - Using Base64 images
function renderThumbnails() {
  const grid = elements.thumbnailsGrid;
  
  const russianSlides = state.presentations.russian.slides || [];
  const englishSlides = state.presentations.english.slides || [];
  const langFilter = state.thumbnailLang || 'both';
  
  console.log('=== RENDER THUMBNAILS ===');
  console.log('Language filter:', langFilter);
  console.log('Russian slides count:', russianSlides.length);
  console.log('English slides count:', englishSlides.length);
  
  // Debug: Check if first slide has base64
  if (russianSlides.length > 0) {
    const hasBase64 = !!russianSlides[0].thumbnailBase64;
    console.log('First RU slide has thumbnailBase64:', hasBase64);
    if (hasBase64) {
      console.log('thumbnailBase64 length:', russianSlides[0].thumbnailBase64.length);
      console.log('thumbnailBase64 starts with:', russianSlides[0].thumbnailBase64.substring(0, 30));
    }
  }
  
  const count = Math.max(russianSlides.length, englishSlides.length);
  
  if (count === 0) {
    grid.innerHTML = '<div class="no-slides-message">No slides loaded yet.</div>';
    return;
  }
  
  // Clear and build using innerHTML (this approach works reliably)
  let html = '';
  
  for (let i = 0; i < count; i++) {
    const ruSlide = russianSlides[i];
    const enSlide = englishSlides[i];
    
    // Use base64 thumbnails (data URLs work reliably in Electron)
    const ruThumb = ruSlide?.thumbnailBase64 || '';
    const enThumb = enSlide?.thumbnailBase64 || '';
    const text = (ruSlide?.text || enSlide?.text || '').substring(0, 80) || '—';
    const activeClass = i === state.currentSlide ? ' active' : '';
    
    // Determine flags based on filter
    let flagsText = 'RU | EN';
    if (langFilter === 'russian') flagsText = 'RU';
    else if (langFilter === 'english') flagsText = 'EN';
    
    // Build Russian image HTML
    let ruImgHtml = '';
    if (langFilter === 'both' || langFilter === 'russian') {
      if (ruThumb) {
        ruImgHtml = `<div style="flex:1;height:150px;min-height:150px;background:#000;overflow:hidden;display:flex;align-items:center;justify-content:center;"><img src="${ruThumb}" alt="RU ${i+1}" style="max-width:100%;max-height:150px;object-fit:contain;display:block;"></div>`;
      } else {
        ruImgHtml = `<div style="flex:1;height:150px;min-height:150px;background:#0a0a15;display:flex;align-items:center;justify-content:center;color:#444;">RU</div>`;
      }
    }
    
    // Build English image HTML
    let enImgHtml = '';
    if (langFilter === 'both' || langFilter === 'english') {
      if (enThumb) {
        enImgHtml = `<div style="flex:1;height:150px;min-height:150px;background:#000;overflow:hidden;display:flex;align-items:center;justify-content:center;"><img src="${enThumb}" alt="EN ${i+1}" style="max-width:100%;max-height:150px;object-fit:contain;display:block;"></div>`;
      } else {
        enImgHtml = `<div style="flex:1;height:150px;min-height:150px;background:#0a0a15;display:flex;align-items:center;justify-content:center;color:#444;">EN</div>`;
      }
    }
    
    const singleLangClass = langFilter !== 'both' ? ' single-lang' : '';
    
    // Use INLINE styles with explicit heights to force visibility
    html += `
      <div class="thumbnail-item${activeClass}" data-index="${i}" style="min-height:175px;">
        <div class="thumb-header" style="padding:6px 10px;background:#252535;font-size:12px;display:flex;justify-content:space-between;">
          <span class="thumb-num">${i + 1}</span>
          <span class="thumb-flags">${flagsText}</span>
        </div>
        <div class="thumb-images${singleLangClass}" style="display:flex;gap:2px;padding:2px;background:#000;height:150px;min-height:150px;">
          ${ruImgHtml}
          ${enImgHtml}
        </div>
        <div class="thumb-text" style="padding:6px 10px;font-size:11px;color:#888;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${text}</div>
      </div>
    `;
  }
  
  grid.innerHTML = html;
  
  // DEBUG: Check what was actually rendered
  console.log('=== POST-RENDER DEBUG ===');
  const firstItem = grid.querySelector('.thumbnail-item');
  if (firstItem) {
    console.log('First thumbnail-item found');
    console.log('  offsetWidth:', firstItem.offsetWidth);
    console.log('  offsetHeight:', firstItem.offsetHeight);
    
    const thumbImages = firstItem.querySelector('.thumb-images');
    if (thumbImages) {
      console.log('  .thumb-images offsetHeight:', thumbImages.offsetHeight);
      console.log('  .thumb-images computed height:', getComputedStyle(thumbImages).height);
    }
    
    const imgWrapper = firstItem.querySelector('.thumb-img-wrapper');
    if (imgWrapper) {
      console.log('  .thumb-img-wrapper offsetHeight:', imgWrapper.offsetHeight);
      console.log('  .thumb-img-wrapper computed height:', getComputedStyle(imgWrapper).height);
    }
    
    const img = firstItem.querySelector('img');
    if (img) {
      console.log('  <img> found!');
      console.log('    src length:', img.src.length);
      console.log('    src starts with:', img.src.substring(0, 50));
      console.log('    complete:', img.complete);
      console.log('    naturalWidth:', img.naturalWidth);
      console.log('    naturalHeight:', img.naturalHeight);
      console.log('    offsetWidth:', img.offsetWidth);
      console.log('    offsetHeight:', img.offsetHeight);
      
      // Check if it loads
      img.onload = () => console.log('  Image onload fired! naturalWidth:', img.naturalWidth);
      img.onerror = (e) => console.error('  Image onerror fired!', e);
    } else {
      console.log('  No <img> element found in first thumbnail!');
    }
  } else {
    console.log('No thumbnail-item found after render!');
  }
  
  // Add click handlers
  grid.querySelectorAll('.thumbnail-item').forEach(item => {
    item.addEventListener('click', () => {
      const index = parseInt(item.dataset.index, 10);
      goToSlide(index);
    });
  });
  
  console.log(`Rendered ${count} thumbnail items with base64 images`);
}

// Keyboard Handling
function handleKeyboard(event) {
  // Only handle if not in an input field
  if (event.target.tagName === 'INPUT' || event.target.tagName === 'SELECT') return;
  
  switch (event.key) {
    case 'ArrowRight':
    case ' ':
      event.preventDefault();
      navigateSlide(1);
      break;
    case 'ArrowLeft':
      event.preventDefault();
      navigateSlide(-1);
      break;
    case 'Home':
      event.preventDefault();
      goToSlide(0);
      break;
    case 'End':
      event.preventDefault();
      goToSlide(state.totalSlides - 1);
      break;
  }
}

// Utility Functions
function setStatus(message) {
  elements.statusMessage.textContent = message;
  console.log('[Status]', message);
}

// Watch for display dropdown changes
elements.russianDisplay.addEventListener('change', () => {
  checkReadyState();
  saveCurrentSettings();
});
elements.englishDisplay.addEventListener('change', () => {
  checkReadyState();
  saveCurrentSettings();
});
elements.singerDisplay.addEventListener('change', saveCurrentSettings);
elements.singerLanguage.addEventListener('change', saveCurrentSettings);

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', init);
