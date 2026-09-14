'use strict';
const { contextBridge, ipcRenderer } = require('electron');
// A projection surface can only receive public caption frames.
contextBridge.exposeInMainWorld('api', {
  onTranslationFrame(callback) {
    const listener = (_event, frame) => callback(frame);
    ipcRenderer.on('translation:frame', listener);
    return () => ipcRenderer.removeListener('translation:frame', listener);
  }
});
