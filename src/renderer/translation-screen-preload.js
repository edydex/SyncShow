'use strict';
const { contextBridge, ipcRenderer } = require('electron');
// Public caption frames plus content-free local rendering diagnostics.
contextBridge.exposeInMainWorld('api', {
  reportTranslationRendered: report => ipcRenderer.send('translation:rendered', report),
  onTranslationFrame(callback) {
    const listener = (_event, frame) => callback(frame);
    ipcRenderer.on('translation:frame', listener);
    return () => ipcRenderer.removeListener('translation:frame', listener);
  }
});
