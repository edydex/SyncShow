(function () {
  'use strict';
  const workspace = globalThis.LibreShowWorkspace, portable = globalThis.SyncShowPortable, model = globalThis.LibreShowEditor;
  const store = globalThis.LibreShowRecovery.createRecoveryStore();
  const $ = id => document.getElementById(id);
  let timer, requestVersion = 0;
  async function refresh() {
    const request = ++requestVersion;
    try {
      const copies = await store.list(); if (request !== requestVersion) return;
      const previous = $('recovery-list').value; $('recovery-list').replaceChildren();
      for (const copy of copies) {
        const option = document.createElement('option'); option.value = copy.id;
        option.textContent = `${copy.title} · ${new Date(copy.savedAt).toLocaleString()}${copy.unsaved ? ' · not downloaded' : ''}`;
        $('recovery-list').append(option);
      }
      if (copies.some(copy => copy.id === previous)) $('recovery-list').value = previous;
      $('restore').disabled = !copies.length; $('forget').disabled = !copies.length;
      if (!workspace.state().project) $('recovery-status').textContent = copies.length ? 'Choose a recovery copy to continue on this browser.' : 'No recovery copies yet. Your edits will be saved locally.';
    } catch (error) { $('recovery-status').textContent = `Recovery unavailable: ${error.message} Download a copy to keep your work.`; }
  }
  function snapshot() {
    const state = workspace.state(); if (!state.project) return null;
    const output = portable.writeBundle(state.project, state.assets);
    return { schemaVersion: 1, id: state.workspaceId, title: state.project.title, savedAt: new Date().toISOString(),
      archive: output.bytes.buffer.slice(output.bytes.byteOffset, output.bytes.byteOffset + output.bytes.byteLength),
      selected: state.selected, unsaved: state.changed || state.formDirty, editVersion: state.version,
      pending: state.formDirty ? { title: $('item-title').value, operatorNotes: $('item-notes').value,
        textByChannel: Object.fromEntries([...$('texts').querySelectorAll('textarea')].map(text => [text.dataset.channel, text.value])) } : null };
  }
  async function persist(copy) {
    if (!copy) return;
    try {
      await store.write(copy); const current = workspace.state();
      if (copy.id === current.workspaceId && copy.editVersion === current.version) $('recovery-status').textContent = 'Recovery copy saved on this browser, including pending text edits. Download for a durable copy.';
      await refresh();
    } catch (error) {
      if (copy.id === workspace.state().workspaceId) $('recovery-status').textContent = `Recovery could not be saved: ${error.message} Download now; your work is still in this tab.`;
    }
  }
  function saveNow() {
    clearTimeout(timer);
    try { void persist(snapshot()); } catch (error) { $('recovery-status').textContent = `Recovery could not be saved: ${error.message} Download a copy.`; }
  }
  document.addEventListener('libreshow:state', () => {
    clearTimeout(timer); if (!workspace.state().project) return;
    $('recovery-status').textContent = 'Saving a recovery copy on this browser…'; timer = setTimeout(saveNow, 350);
  });
  document.addEventListener('libreshow:before-replace', saveNow);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveNow(); });
  $('restore').addEventListener('click', async () => {
    if (!workspace.protectService()) return;
    const at = workspace.state().version;
    try {
      const copy = await store.load($('recovery-list').value);
      if (!copy || copy.schemaVersion !== 1 || !(copy.archive instanceof ArrayBuffer)) throw new Error('Unsupported recovery copy; it has been left untouched.');
      const loaded = portable.readBundle(copy.archive), pending = copy.pending;
      if (pending) {
        const item = loaded.project.items[copy.selected];
        if (!item || !(item.kind === 'group' || model.editableText(item))
          || JSON.stringify(Object.keys(pending).sort()) !== JSON.stringify(['operatorNotes', 'textByChannel', 'title'])
          || typeof pending.title !== 'string' || pending.title.length > 200
          || typeof pending.operatorNotes !== 'string' || pending.operatorNotes.length > 10000
          || !pending.textByChannel || typeof pending.textByChannel !== 'object' || Array.isArray(pending.textByChannel)
          || Object.entries(pending.textByChannel).some(([id, text]) => !loaded.project.channelIds.includes(id) || typeof text !== 'string' || text.length > 20000)) throw new Error('Unsupported pending edits; the recovery copy has been left untouched.');
      }
      if (workspace.state().version !== at) throw new Error('Your service changed while recovery was loading. Try again when ready.');
      workspace.restore(loaded, copy); workspace.message('Recovery restored locally, including pending item edits. Original recovery copies remain available.');
    } catch (error) { workspace.message(`Recovery stopped: ${error.message}`); }
  });
  $('forget').addEventListener('click', async () => {
    const id = $('recovery-list').value;
    if (!id || !confirm('Remove this recovery copy from this browser? Download a file first if you need to keep it.')) return;
    if (id === workspace.state().workspaceId) clearTimeout(timer);
    try { await store.remove(id); await refresh(); $('recovery-status').textContent = 'Recovery copy removed. New edits create a recovery copy again.'; }
    catch (error) { workspace.message(`Could not remove recovery: ${error.message}`); }
  });
  void refresh();
})();
