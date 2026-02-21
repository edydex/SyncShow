const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('api', {
  // Dialog operations
  openPptxDialog: (language) => ipcRenderer.invoke('dialog:openPptx', language),
  
  // PPTX conversion
  convertPptx: (filePath, language) => ipcRenderer.invoke('pptx:convert', { filePath, language }),
  
  // Slide operations
  getSlideList: (language) => ipcRenderer.invoke('slides:getList', language),
  navigateToSlide: (slideIndex) => ipcRenderer.send('slide:navigate', slideIndex),
  nextSlide: () => ipcRenderer.send('slide:next'),
  prevSlide: () => ipcRenderer.send('slide:prev'),
  
  // Display operations
  startPresentation: (displays) => ipcRenderer.invoke('display:start', displays),
  stopPresentation: () => ipcRenderer.invoke('display:stop'),
  showDisplays: () => ipcRenderer.invoke('display:show'),
  clearDisplays: () => ipcRenderer.invoke('display:clear'),
  hideDisplays: () => ipcRenderer.invoke('display:hide'),
  refreshDisplays: () => ipcRenderer.invoke('displays:refresh'),
  setFadeDuration: (duration) => ipcRenderer.invoke('display:setFade', duration),
  setSyncMode: (enabled) => ipcRenderer.invoke('display:setSyncMode', enabled),
  
  // App state
  getAppState: () => ipcRenderer.invoke('app:getState'),
  
  // User settings (persisted)
  loadSettings: () => ipcRenderer.invoke('settings:load'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  
  // Cache operations (for restoring previous presentations)
  checkCache: (language) => ipcRenderer.invoke('cache:check', language),
  loadFromCache: (language) => ipcRenderer.invoke('cache:load', language),
  
  // Event listeners
  onDisplaysUpdated: (callback) => {
    ipcRenderer.on('displays:updated', (event, displays) => callback(displays));
  },
  
  onConversionProgress: (callback) => {
    ipcRenderer.on('conversion:progress', (event, data) => callback(data));
  },
  
  onSlideChanged: (callback) => {
    ipcRenderer.on('slide:changed', (event, data) => callback(data));
  },

  onDisplaysCleared: (callback) => {
    ipcRenderer.on('displays:cleared', (event) => callback());
  },
  
  // Display window specific
  onDisplayInit: (callback) => {
    ipcRenderer.on('display:init', (event, data) => callback(data));
  },
  
  onSlideGoto: (callback) => {
    ipcRenderer.on('slide:goto', (event, data) => callback(data));
  },
  
  onDisplayClear: (callback) => {
    ipcRenderer.on('display:clear', (event) => callback());
  },

  onFadeUpdate: (callback) => {
    ipcRenderer.on('display:fadeUpdate', (event, duration) => callback(duration));
  },

  onSyncModeUpdate: (callback) => {
    ipcRenderer.on('display:syncModeUpdate', (event, enabled) => callback(enabled));
  },

  // Singer screen specific
  onSingerUpdate: (callback) => {
    ipcRenderer.on('singer:update', (event, data) => callback(data));
  },

  onSingerPreview: (callback) => {
    ipcRenderer.on('singer:preview', (event, dataUrl) => callback(dataUrl));
  },

  requestSingerPreview: () => ipcRenderer.send('singer:requestPreview'),
  
  // Remove listeners (for cleanup)
  removeAllListeners: (channel) => {
    ipcRenderer.removeAllListeners(channel);
  }
});

// Expose path utilities for image loading
contextBridge.exposeInMainWorld('pathUtils', {
  // Convert file path to file:// URL for image loading
  toFileUrl: (filePath) => {
    if (!filePath) return '';
    // Handle Windows paths
    const normalized = filePath.replace(/\\/g, '/');
    return `file:///${normalized}`;
  }
});
