const { app, BrowserWindow, ipcMain, screen, dialog, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

// Keep references to prevent garbage collection
let controlWindow = null;
let displayWindows = {};
let singerWindow = null;

// Application state
let appState = {
  presentations: {
    russian: null,
    english: null
  },
  currentSlide: 0,
  totalSlides: 0,
  displays: [],
  displayAssignments: {
    russian: null,
    english: null,
    singer: null
  },
  slideCache: {
    russian: [],
    english: [],
    metadata: {}
  },
  isCleared: false,  // Track if displays are currently cleared (black)
  singerLanguage: 'russian',
  fadeDuration: 300,  // Fade transition duration in ms
  syncMode: false  // Experimental: coordinate exact reveal timing across displays
};

// Track last Esc press for double-tap detection
let lastEscPress = 0;

// Conversion queue to prevent concurrent conversions
let conversionQueue = [];
let isConverting = false;

// Determine if running in production (packaged) or development
const isPackaged = app.isPackaged;

// Get the correct paths for packaged vs development mode
function getResourcePath(relativePath) {
  if (isPackaged) {
    // In production, resources are in the resources folder
    return path.join(process.resourcesPath, relativePath);
  } else {
    // In development, use __dirname
    return path.join(__dirname, relativePath);
  }
}

// Get cache directory - must be writable (not inside asar)
function getCacheDir() {
  if (isPackaged) {
    // Use app's userData folder for cache in production
    return path.join(app.getPath('userData'), 'cache');
  } else {
    // Use local cache folder in development
    return path.join(__dirname, 'cache');
  }
}

// Find Python executable - prefer bundled, fallback to system
function getPythonPath() {
  const isWindows = process.platform === 'win32';
  const isMac = process.platform === 'darwin';
  const isLinux = process.platform === 'linux';
  
  // Determine Python executable name based on platform
  const pythonExe = isWindows ? 'python.exe' : 'bin/python3';
  
  if (isPackaged) {
    // Check for bundled Python
    const bundledPython = path.join(process.resourcesPath, 'python-embed', pythonExe);
    if (fs.existsSync(bundledPython)) {
      console.log('[Python] Using bundled Python:', bundledPython);
      return bundledPython;
    }
  } else {
    // In development, check for local python-embed folder
    const devPython = path.join(__dirname, 'python-embed', pythonExe);
    if (fs.existsSync(devPython)) {
      console.log('[Python] Using dev bundled Python:', devPython);
      return devPython;
    }
  }
  
  // Fallback to system Python
  console.log('[Python] Using system Python');
  // On Unix systems, try python3 first, then python
  if (!isWindows) {
    return 'python3';
  }
  return 'python';
}

// Configuration
const CONFIG = {
  thumbnailWidth: 300,
  thumbnailHeight: 169,
  displayWidth: 1920,
  displayHeight: 1080,
  get cacheDir() { return getCacheDir(); },
  get pythonPath() { return getPythonPath(); }
};

// Ensure cache directory exists (must be called after app is ready)
function ensureCacheDir() {
  const cacheDir = CONFIG.cacheDir;
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }
}

function createControlWindow() {
  const primaryDisplay = screen.getPrimaryDisplay();
  
  controlWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1200,
    minHeight: 700,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    icon: path.join(__dirname, 'assets', 'icon.png'),
    title: 'SyncShow - Control Panel',
    show: false
  });

  controlWindow.loadFile(path.join(__dirname, 'src', 'renderer', 'index.html'));
  
  controlWindow.once('ready-to-show', () => {
    controlWindow.show();
    // Detect available displays
    updateDisplayList();
  });

  controlWindow.on('closed', () => {
    controlWindow = null;
    // Close all display windows when control panel closes
    Object.values(displayWindows).forEach(win => {
      if (win && !win.isDestroyed()) win.close();
    });
    if (singerWindow && !singerWindow.isDestroyed()) singerWindow.close();
    app.quit();
  });

  // Open DevTools in development
  if (process.argv.includes('--dev')) {
    controlWindow.webContents.openDevTools();
  }
}

function createDisplayWindow(displayId, displayInfo, language) {
  const { bounds } = displayInfo;
  
  // For Windows: Use fullscreen mode with proper bounds
  // Kiosk mode doesn't work reliably on secondary displays
  const win = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    frame: false,
    fullscreen: false,  // Will set fullscreen after show
    fullscreenable: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: '#000000',
    focusable: true,
    // Important: This enables proper fullscreen behavior
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    show: false
  });

  win.loadFile(path.join(__dirname, 'src', 'renderer', 'display.html'));
  
  win.once('ready-to-show', () => {
    // First, position the window on the correct display
    win.setBounds({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height
    });
    
    // Show the window
    win.show();
    
    // Now enter fullscreen mode on THIS display
    // This is the key - setFullScreen after the window is on the correct display
    win.setFullScreen(true);
    
    // Set always on top with highest level
    win.setAlwaysOnTop(true, 'screen-saver');
    
    // Focus the window
    win.focus();
    
    // Send initial configuration
    win.webContents.send('display:init', { 
      language, 
      displayId, 
      fadeDuration: appState.fadeDuration,
      syncMode: appState.syncMode 
    });
    
    console.log(`[Display] Created ${language} window on display ${displayId} at ${bounds.x},${bounds.y} ${bounds.width}x${bounds.height}`);
  });

  // Prevent window from being closed accidentally
  win.on('close', (e) => {
    if (controlWindow && !controlWindow.isDestroyed()) {
      e.preventDefault();
      win.hide();
    }
  });

  return win;
}

function createSingerWindow(displayInfo) {
  const { bounds } = displayInfo;
  
  singerWindow = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    frame: false,
    fullscreen: false,  // Will set fullscreen after show
    fullscreenable: true,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: '#000000',
    focusable: true,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    show: false
  });

  singerWindow.loadFile(path.join(__dirname, 'src', 'renderer', 'singer.html'));
  
  singerWindow.webContents.once('did-finish-load', () => {
    console.log('[Singer] Content loaded');
  });
  
  singerWindow.once('ready-to-show', () => {
    // First, position the window on the correct display
    singerWindow.setBounds({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height
    });
    
    // Show the window
    singerWindow.show();
    
    // Now enter fullscreen mode on THIS display
    singerWindow.setFullScreen(true);
    
    // Set always on top with highest level
    singerWindow.setAlwaysOnTop(true, 'screen-saver');
    
    singerWindow.focus();
    
    console.log(`[Display] Created singer window at ${bounds.x},${bounds.y} ${bounds.width}x${bounds.height}`);
  });

  return singerWindow;
}

function updateDisplayList() {
  appState.displays = screen.getAllDisplays().map((display, index) => ({
    id: display.id,
    index: index,
    label: `Display ${index + 1}${display.internal ? ' (Built-in)' : ''} - ${display.bounds.width}x${display.bounds.height}`,
    bounds: display.bounds,
    isPrimary: display.bounds.x === 0 && display.bounds.y === 0
  }));
  
  if (controlWindow) {
    controlWindow.webContents.send('displays:updated', appState.displays);
  }
}

// Track if shortcuts are registered
let shortcutsRegistered = false;

// Register keyboard shortcuts
function registerGlobalShortcuts() {
  if (shortcutsRegistered) return;
  
  // These shortcuts work even when display windows are focused
  globalShortcut.register('Right', () => navigateSlide(1));
  globalShortcut.register('Left', () => navigateSlide(-1));
  globalShortcut.register('Space', () => navigateSlide(1));
  globalShortcut.register('Home', () => goToSlide(0));
  globalShortcut.register('End', () => goToSlide(appState.totalSlides - 1));
  
  // Escape key: first press clears to black, double-press hides displays
  globalShortcut.register('Escape', () => {
    const now = Date.now();
    const timeSinceLastEsc = now - lastEscPress;
    lastEscPress = now;
    
    if (timeSinceLastEsc < 500) {
      // Double-press: hide displays completely
      hideDisplayWindows();
    } else if (!appState.isCleared) {
      // First press: clear to black
      clearAllDisplays();
    } else {
      // Already cleared, single press again hides
      hideDisplayWindows();
    }
  });
  
  // Number keys for quick navigation (1-9 for slides 1-9, 0 for slide 10)
  for (let i = 0; i <= 9; i++) {
    globalShortcut.register(`${i}`, () => {
      const slideNum = i === 0 ? 9 : i - 1;
      if (slideNum < appState.totalSlides) {
        goToSlide(slideNum);
      }
    });
  }
  
  shortcutsRegistered = true;
}

// Unregister keyboard shortcuts
function unregisterGlobalShortcuts() {
  if (!shortcutsRegistered) return;
  
  globalShortcut.unregister('Right');
  globalShortcut.unregister('Left');
  globalShortcut.unregister('Space');
  globalShortcut.unregister('Home');
  globalShortcut.unregister('End');
  globalShortcut.unregister('Escape');
  
  for (let i = 0; i <= 9; i++) {
    globalShortcut.unregister(`${i}`);
  }
  
  shortcutsRegistered = false;
}

function navigateSlide(delta) {
  const newSlide = appState.currentSlide + delta;
  if (newSlide >= 0 && newSlide < appState.totalSlides) {
    goToSlide(newSlide);
  }
}

function goToSlide(slideIndex) {
  if (slideIndex < 0 || slideIndex >= appState.totalSlides) return;
  
  appState.currentSlide = slideIndex;
  const timestamp = Date.now();
  
  // In sync mode, calculate a target reveal time in the future
  // This gives all windows time to load and prepare, then reveal simultaneously
  const revealDelay = appState.syncMode ? 100 : 0;  // 100ms coordination window
  const revealAt = timestamp + revealDelay;
  
  // Send to all display windows simultaneously
  const slideData = {
    index: slideIndex,
    timestamp: timestamp,
    revealAt: revealAt,  // Target time to reveal (used in sync mode)
    syncMode: appState.syncMode,
    preload: {
      prev: Math.max(0, slideIndex - 1),
      next: Math.min(appState.totalSlides - 1, slideIndex + 1)
    }
  };
  
  Object.entries(displayWindows).forEach(([lang, win]) => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('slide:goto', {
        ...slideData,
        language: lang,
        imagePath: getSlideImagePath(lang, slideIndex),
        preloadPaths: {
          prev: getSlideImagePath(lang, slideData.preload.prev),
          next: getSlideImagePath(lang, slideData.preload.next)
        }
      });
    }
  });
  
  // Update singer screen with current slide image + next slide text
  if (singerWindow && !singerWindow.isDestroyed()) {
    const singerLang = appState.singerLanguage || 'russian';
    const currentSlideImage = getSlideImagePath(singerLang, slideIndex);
    const nextSlideText = getSlideText(singerLang, slideIndex + 1);
    
    console.log(`[Singer] Sending update: slide ${slideIndex + 1}, lang ${singerLang}, image: ${currentSlideImage ? 'yes' : 'no'}, nextText: "${nextSlideText?.substring(0, 30) || 'none'}..."`);
    
    singerWindow.webContents.send('singer:update', {
      currentSlide: slideIndex + 1,
      currentSlideImage: currentSlideImage,
      nextSlideText: nextSlideText,
      totalSlides: appState.totalSlides,
      language: singerLang
    });
  } else {
    console.log('[Singer] Window not available');
  }
  
  // Update control panel
  if (controlWindow && !controlWindow.isDestroyed()) {
    controlWindow.webContents.send('slide:changed', {
      currentSlide: slideIndex,
      totalSlides: appState.totalSlides
    });
  }
}

function getSlideImagePath(language, slideIndex) {
  const presentation = appState.presentations[language];
  if (!presentation) {
    console.log(`[getSlideImagePath] No presentation for ${language}`);
    return null;
  }
  if (!presentation.cacheDir) {
    console.log(`[getSlideImagePath] No cacheDir for ${language}`);
    return null;
  }
  
  const paddedIndex = String(slideIndex + 1).padStart(3, '0');
  const imagePath = path.join(presentation.cacheDir, `slide_${paddedIndex}.jpg`);
  
  // Check if file exists
  if (!fs.existsSync(imagePath)) {
    console.log(`[getSlideImagePath] File not found: ${imagePath}`);
    return null;
  }
  
  return imagePath;
}

function getSlideText(language, slideIndex) {
  const presentation = appState.presentations[language];
  if (!presentation) {
    console.log(`[getSlideText] No presentation for ${language}`);
    return '';
  }
  if (!presentation.metadata) {
    console.log(`[getSlideText] No metadata for ${language}`);
    return '';
  }
  
  const metadata = presentation.metadata;
  if (metadata && metadata.slides && metadata.slides[slideIndex]) {
    const text = metadata.slides[slideIndex].firstLine || metadata.slides[slideIndex].text || '';
    console.log(`[getSlideText] ${language} slide ${slideIndex}: "${text.substring(0, 50)}..."`);
    return text;
  }
  console.log(`[getSlideText] No slide data for ${language} index ${slideIndex}`);
  return '';
}

function hideDisplayWindows() {
  Object.values(displayWindows).forEach(win => {
    if (win && !win.isDestroyed()) {
      win.setFullScreen(false);  // Exit fullscreen before hiding
      win.hide();
    }
  });
  if (singerWindow && !singerWindow.isDestroyed()) {
    singerWindow.setFullScreen(false);
    singerWindow.hide();
  }
}

// Clear all displays to black
function clearAllDisplays() {
  appState.isCleared = true;
  Object.values(displayWindows).forEach(win => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('display:clear');
    }
  });
  if (singerWindow && !singerWindow.isDestroyed()) {
    singerWindow.webContents.send('display:clear');
  }
  // Notify control panel
  if (controlWindow && !controlWindow.isDestroyed()) {
    controlWindow.webContents.send('displays:cleared');
  }
}

// Show all displays and re-send current slide
function showAllDisplays() {
  appState.isCleared = false;
  
  // Re-show windows if hidden
  Object.values(displayWindows).forEach(win => {
    if (win && !win.isDestroyed() && !win.isVisible()) {
      win.show();
      win.setFullScreen(true);
    }
  });
  if (singerWindow && !singerWindow.isDestroyed() && !singerWindow.isVisible()) {
    singerWindow.show();
    singerWindow.setFullScreen(true);
  }
  
  // Re-send current slide to all displays
  goToSlide(appState.currentSlide);
}

// IPC Handlers
ipcMain.handle('dialog:openPptx', async (event, language) => {
  const result = await dialog.showOpenDialog(controlWindow, {
    title: `Select ${language.charAt(0).toUpperCase() + language.slice(1)} PowerPoint`,
    filters: [
      { name: 'PowerPoint Files', extensions: ['pptx', 'ppt'] }
    ],
    properties: ['openFile']
  });
  
  if (!result.canceled && result.filePaths.length > 0) {
    return result.filePaths[0];
  }
  return null;
});

// Process conversion queue
async function processConversionQueue() {
  if (isConverting || conversionQueue.length === 0) return;
  
  isConverting = true;
  const { filePath, language, resolve, reject } = conversionQueue.shift();
  
  try {
    const result = await runConversion(filePath, language);
    resolve(result);
  } catch (error) {
    reject(error);
  } finally {
    isConverting = false;
    // Process next in queue
    processConversionQueue();
  }
}

// Actual conversion function
function runConversion(filePath, language) {
  return new Promise((resolve, reject) => {
    const outputDir = path.join(CONFIG.cacheDir, language);
    
    // Ensure output directory exists
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    
    // Run Python converter - use getResourcePath for packaged app
    const pythonScript = getResourcePath(path.join('python', 'converter.py'));
    const pythonProcess = spawn(CONFIG.pythonPath, [
      pythonScript,
      '--input', filePath,
      '--output', outputDir,
      '--width', CONFIG.displayWidth.toString(),
      '--height', CONFIG.displayHeight.toString(),
      '--thumbnail-width', CONFIG.thumbnailWidth.toString()
    ], {
      // Set UTF-8 encoding for subprocess
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
    });
    
    let stdout = '';
    let stderr = '';
    
    pythonProcess.stdout.on('data', (data) => {
      stdout += data.toString();
      // Send progress updates to renderer
      const lines = data.toString().split('\n');
      lines.forEach(line => {
        if (line.startsWith('PROGRESS:')) {
          const progress = parseInt(line.replace('PROGRESS:', '').trim());
          if (controlWindow && !controlWindow.isDestroyed()) {
            controlWindow.webContents.send('conversion:progress', { language, progress });
          }
        }
      });
    });
    
    pythonProcess.stderr.on('data', (data) => {
      stderr += data.toString();
      console.error('Python error:', data.toString());
    });
    
    pythonProcess.on('close', (code) => {
      if (code === 0) {
        // Read the generated metadata
        const metadataPath = path.join(outputDir, 'metadata.json');
        let metadata = {};
        if (fs.existsSync(metadataPath)) {
          metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
          console.log(`[Metadata] Loaded for ${language}: ${metadata.slides?.length || 0} slides`);
          if (metadata.slides && metadata.slides[0]) {
            console.log(`[Metadata] First slide text sample: "${metadata.slides[0].firstLine?.substring(0, 50) || metadata.slides[0].text?.substring(0, 50) || 'none'}..."`);
          }
        } else {
          console.log(`[Metadata] No metadata file found at ${metadataPath}`);
        }
        
        // Count slides
        const slideFiles = fs.readdirSync(outputDir)
          .filter(f => f.startsWith('slide_') && f.endsWith('.jpg') && !f.includes('_thumb'));
        
        const result = {
          success: true,
          cacheDir: outputDir,
          slideCount: slideFiles.length,
          metadata: metadata
        };
        
        // Update app state
        appState.presentations[language] = result;
        console.log(`[State] Presentation ${language} stored with ${result.slideCount} slides and metadata: ${metadata.slides?.length || 0} slides`);
        
        resolve(result);
      } else {
        reject(new Error(`Conversion failed: ${stderr}`));
      }
    });
  });
}

// Queued conversion handler - prevents concurrent conversions
ipcMain.handle('pptx:convert', async (event, { filePath, language }) => {
  return new Promise((resolve, reject) => {
    // Add to queue
    conversionQueue.push({ filePath, language, resolve, reject });
    // Start processing if not already
    processConversionQueue();
  });
});

ipcMain.handle('slides:getList', async (event, language) => {
  const presentation = appState.presentations[language];
  if (!presentation) return [];
  
  const slideFiles = fs.readdirSync(presentation.cacheDir)
    .filter(f => f.startsWith('slide_') && f.endsWith('.jpg') && !f.includes('_thumb'))
    .sort();
  
  // Read thumbnail images as base64 for reliable display
  return slideFiles.map((file, index) => {
    const thumbFile = file.replace('.jpg', '_thumb.jpg');
    const thumbPath = path.join(presentation.cacheDir, thumbFile);
    const imagePath = path.join(presentation.cacheDir, file);
    
    // Read thumbnail as base64
    let thumbnailBase64 = '';
    try {
      if (fs.existsSync(thumbPath)) {
        const thumbBuffer = fs.readFileSync(thumbPath);
        thumbnailBase64 = `data:image/jpeg;base64,${thumbBuffer.toString('base64')}`;
      }
    } catch (e) {
      console.error(`Error reading thumbnail ${thumbFile}:`, e);
    }
    
    return {
      index: index,
      imagePath: imagePath,
      thumbnailPath: thumbPath,
      thumbnailBase64: thumbnailBase64,  // New: base64 for thumbnails
      text: presentation.metadata?.slides?.[index]?.text || ''
    };
  });
});

ipcMain.handle('display:start', async (event, { russianDisplayId, englishDisplayId, singerDisplayId, singerLanguage, fadeDuration, syncMode }) => {
  const displays = screen.getAllDisplays();
  
  // Store singer language setting
  appState.singerLanguage = singerLanguage || 'russian';
  
  // Store fade duration setting
  appState.fadeDuration = fadeDuration !== undefined ? fadeDuration : 300;
  
  // Store sync mode setting
  appState.syncMode = syncMode || false;
  
  // Create Russian display window
  if (russianDisplayId !== null && russianDisplayId !== undefined) {
    const russianDisplay = displays.find(d => d.id === russianDisplayId) || displays[russianDisplayId];
    if (russianDisplay) {
      displayWindows.russian = createDisplayWindow(russianDisplayId, russianDisplay, 'russian');
      appState.displayAssignments.russian = russianDisplayId;
    }
  }
  
  // Create English display window
  if (englishDisplayId !== null && englishDisplayId !== undefined) {
    const englishDisplay = displays.find(d => d.id === englishDisplayId) || displays[englishDisplayId];
    if (englishDisplay) {
      displayWindows.english = createDisplayWindow(englishDisplayId, englishDisplay, 'english');
      appState.displayAssignments.english = englishDisplayId;
    }
  }
  
  // Create Singer display window (optional)
  if (singerDisplayId !== null && singerDisplayId !== undefined) {
    const singerDisplay = displays.find(d => d.id === singerDisplayId) || displays[singerDisplayId];
    if (singerDisplay) {
      singerWindow = createSingerWindow(singerDisplay);
      appState.displayAssignments.singer = singerDisplayId;
    }
  }
  
  // Set total slides (use the smaller count if different)
  const russianCount = appState.presentations.russian?.slideCount || 0;
  const englishCount = appState.presentations.english?.slideCount || 0;
  appState.totalSlides = Math.min(russianCount, englishCount);
  
  // Register keyboard shortcuts for presentation
  registerGlobalShortcuts();
  
  // Wait for windows to be ready, then go to first slide
  // Increased timeout to ensure singer window is fully loaded
  setTimeout(() => {
    console.log('[Display] Initial goToSlide(0)');
    goToSlide(0);
  }, 1000);
  
  return { success: true, totalSlides: appState.totalSlides };
});

ipcMain.handle('display:stop', async () => {
  hideDisplayWindows();
  unregisterGlobalShortcuts();
  return { success: true };
});

// Show displays - re-show windows and current slide
ipcMain.handle('display:show', async () => {
  showAllDisplays();
  registerGlobalShortcuts();
  return { success: true };
});

// Clear displays - show black screens but keep windows open
ipcMain.handle('display:clear', async () => {
  clearAllDisplays();
  return { success: true };
});

// Set fade duration for transitions
ipcMain.handle('display:setFade', async (event, duration) => {
  appState.fadeDuration = duration;
  
  // Notify all display windows
  Object.values(displayWindows).forEach(win => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('display:fadeUpdate', duration);
    }
  });
  
  console.log(`[Display] Fade duration set to ${duration}ms`);
  return { success: true };
});

// Set sync mode for coordinated reveal timing
ipcMain.handle('display:setSyncMode', async (event, enabled) => {
  appState.syncMode = enabled;
  
  // Notify all display windows
  Object.values(displayWindows).forEach(win => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('display:syncModeUpdate', enabled);
    }
  });
  
  console.log(`[Display] Sync mode ${enabled ? 'enabled' : 'disabled'}`);
  return { success: true };
});

// Hide displays - hide windows but don't stop presentation
ipcMain.handle('display:hide', async () => {
  hideDisplayWindows();
  return { success: true };
});

ipcMain.on('slide:navigate', (event, slideIndex) => {
  goToSlide(slideIndex);
});

ipcMain.on('slide:next', () => {
  navigateSlide(1);
});

ipcMain.on('slide:prev', () => {
  navigateSlide(-1);
});

ipcMain.handle('app:getState', async () => {
  return {
    currentSlide: appState.currentSlide,
    totalSlides: appState.totalSlides,
    displays: appState.displays,
    presentations: {
      russian: appState.presentations.russian ? { loaded: true, slideCount: appState.presentations.russian.slideCount } : null,
      english: appState.presentations.english ? { loaded: true, slideCount: appState.presentations.english.slideCount } : null
    }
  };
});

ipcMain.handle('displays:refresh', async () => {
  updateDisplayList();
  return appState.displays;
});

// App lifecycle
app.whenReady().then(() => {
  // Ensure cache directory exists now that app is ready
  ensureCacheDir();
  
  createControlWindow();
  // Don't register shortcuts on startup - only when presentation starts
  
  // Handle display changes
  screen.on('display-added', updateDisplayList);
  screen.on('display-removed', updateDisplayList);
});

app.on('window-all-closed', () => {
  globalShortcut.unregisterAll();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createControlWindow();
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});
