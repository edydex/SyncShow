'use strict';
const { contextBridge, ipcRenderer } = require('electron');
let handler = null;
let latest = null;
ipcRenderer.on('translation:cue-command', (_event, command) => {
  latest = command;
  if (handler) handler(command);
});
contextBridge.exposeInMainWorld('syncShowTranslation', {
  version: 1,
  onCommand(callback) {
    if (typeof callback !== 'function') throw new Error('A command handler is required.');
    handler = callback;
    void ipcRenderer.invoke('translation:cue-ready').catch(() => {});
    if (latest) callback(latest);
    return () => { if (handler === callback) handler = null; };
  },
  report(status) { void ipcRenderer.invoke('translation:cue-status', status).catch(() => {}); },
  getInput() { return ipcRenderer.invoke('translation:input:read'); },
  saveInput(input) { return ipcRenderer.invoke('translation:input:write', input); }
});
