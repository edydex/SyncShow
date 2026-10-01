'use strict';

const { ipcRenderer } = require('electron');
let showMode = false;
let boundServiceId = null;
let taking = false;

// This view has no general desktop API. Only main can enable Show interaction;
// the approved editor can then request a take by stable cue identity.
ipcRenderer.on('community:planner:showMode', (_event, mode) => {
  showMode = mode?.enabled === true;
  boundServiceId = showMode && typeof mode.syncId === 'string' ? mode.syncId : null;
  window.postMessage({ type: 'heritage-editor:show-mode', enabled: showMode, syncId: boundServiceId, currentCueId: mode.currentCueId || null }, window.location.origin);
});
window.addEventListener('message', async event => {
  if (!showMode || taking || event.source !== window || event.origin !== window.location.origin
    || event.data?.type !== 'heritage-editor:take' || event.data.syncId !== boundServiceId || typeof event.data.cueId !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(event.data.cueId)) return;
  const syncId = boundServiceId, cueId = event.data.cueId;
  taking = true;
  try {
    const result = await ipcRenderer.invoke('community:planner:take', { syncId, cueId });
    window.postMessage({ type: 'heritage-editor:taken', syncId, cueId, ok: result?.success === true,
      error: result?.error?.message || null }, window.location.origin);
  } catch (error) {
    window.postMessage({ type: 'heritage-editor:taken', syncId, cueId, ok: false, error: error.message }, window.location.origin);
  } finally { taking = false; }
});
