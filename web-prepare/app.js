(function () {
  'use strict';
  const core = globalThis.SyncShowCore, portable = globalThis.SyncShowPortable, model = globalThis.LibreShowEditor;
  const $ = id => document.getElementById(id);
  let project = null, assets = new Map(), selected = null, changed = false, formDirty = false;
  let history = [], pendingDownload = false, stateVersion = 0, workspaceId = null;
  const message = text => { $('message').textContent = text; };
  const clone = value => JSON.parse(JSON.stringify(value));
  const now = () => new Date().toISOString();
  const freshId = () => `browser-${globalThis.SyncShowSharedRuntime.crypto.randomUUID()}`;
  const protectDraft = () => !formDirty || confirm('Discard the item changes that have not been saved?');
  const protectService = () => !(changed || formDirty) || confirm('Open another service? Download this service first if you want to keep your changes.');
  function notify() { stateVersion += 1; document.dispatchEvent(new Event('libreshow:state')); }

  function accept(next, nextSelected = selected) {
    const validated = core.normalizeServiceProject(next);
    // Validate that every retained asset can still be exported before accepting
    // a mutation. The current file and state survive any failure.
    portable.writeBundle(validated, assets);
    history.push(project); if (history.length > 20) history.shift();
    project = validated; selected = nextSelected; changed = true; formDirty = false; pendingDownload = false; render(); notify();
  }
  function install(next, nextAssets, dirty) {
    document.dispatchEvent(new Event('libreshow:before-replace'));
    workspaceId = model.freshId();
    project = next; assets = nextAssets; selected = null; history = [];
    changed = dirty; formDirty = false; pendingDownload = false; render(); notify();
  }
  function select(id) {
    if (!protectDraft()) return;
    selected = id; formDirty = false; render(); notify();
  }
  function render() {
    $('workspace').hidden = !project;
    if (!project) return;
    $('service-title').textContent = project.title;
    $('service-date').textContent = project.serviceDate;
    $('save-state').textContent = changed ? 'Download a copy to keep your changes outside this browser.' : 'No changes since your last open or confirmed download. Your original file is never overwritten.';
    $('undo').disabled = !history.length;
    $('confirm-download').hidden = !pendingDownload;
    $('outline').replaceChildren();
    function item(id, depth) {
      const value = project.items[id];
      const button = document.createElement('button'); button.type = 'button'; button.className = 'outline-item';
      button.style.paddingLeft = `${12 + depth * 14}px`; button.setAttribute('aria-pressed', String(id === selected));
      button.append(document.createTextNode(value.title || value.kind));
      const kind = document.createElement('small'); kind.textContent = value.kind === 'group' ? 'Section' : value.kind; button.append(kind);
      button.addEventListener('click', () => select(id)); $('outline').append(button);
      for (const child of value.childIds || []) item(child, depth + 1);
    }
    for (const id of project.rootItemIds) item(id, 0);
    if (!project.rootItemIds.length) $('outline').textContent = 'Your service starts here. Add a section or text slide.';
    const value = project.items[selected];
    $('selection-help').hidden = Boolean(value); $('edit').hidden = !value; $('preview').hidden = true;
    if (!value) return;
    const plainNotice = model.editableText(value);
    const editable = value.kind === 'group' || plainNotice;
    $('item-kind').textContent = value.kind === 'group' ? 'Service section' : value.kind === 'notice' ? 'Text slide' : `${value.kind} · preserved`;
    $('item-title').value = value.title || ''; $('item-notes').value = value.operatorNotes || '';
    $('item-title').disabled = !editable; $('item-notes').disabled = !editable;
    $('edit').querySelector('button[type=submit]').disabled = !editable;
    $('texts').replaceChildren();
    if (plainNotice) for (const channelId of project.channelIds) {
      const label = document.createElement('label'); label.textContent = `${project.channels[channelId].label} — leave blank to hide this output`;
      const text = document.createElement('textarea'); text.rows = 5; text.maxLength = 20000; text.dataset.channel = channelId;
      text.value = value.textByChannel[channelId] || '';
      label.append(text); $('texts').append(label);
    }
    $('preserved').textContent = editable ? 'Other project content and pinned images remain in the downloaded service.' : 'This item is preserved exactly. Edit its content and presentation settings in desktop SyncShow.';
    if (plainNotice) { $('preview').hidden = false; $('preview').textContent = Object.values(value.textByChannel)[0] || ''; }
    document.dispatchEvent(new Event('libreshow:rendered'));
  }
  async function openFile(file) {
    if (!file || !protectService()) return;
    const openedAt = stateVersion;
    try {
      if (file.size > portable.MAX_BROWSER_BYTES) throw new Error('This browser preview supports files up to 32 MiB. Use desktop SyncShow for larger services.');
      const loaded = portable.readBundle(await file.arrayBuffer());
      if (stateVersion !== openedAt) throw new Error('Your service changed while the file was being read. Try again when ready.');
      install(loaded.project, loaded.assets, false);
      message('Service opened locally. Both extensions use the same verified archive. The original stays untouched.');
    } catch (error) { message(`Could not open this file. ${error.message} Your current service and original file have not changed.`); }
  }
  $('open').addEventListener('click', () => $('file').click());
  $('file').addEventListener('change', event => { const file = event.target.files[0]; event.target.value = ''; void openFile(file); });
  $('start').addEventListener('click', () => { if (protectService()) { $('new-date').value = new Date().toISOString().slice(0, 10); $('new-service').showModal(); } });
  $('close-new').addEventListener('click', () => $('new-service').close());
  $('new-service').addEventListener('keydown', event => {
    if (event.key !== 'Tab') return;
    const controls = [...$('new-service').querySelectorAll('input:not([disabled]),button:not([disabled])')];
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
  $('create').addEventListener('submit', event => {
    event.preventDefault();
    try {
      const next = core.createServiceProject({ id: freshId(), title: $('new-title').value, serviceDate: $('new-date').value,
        profileId: 'browser-preparation', channels: [{ id: 'english', label: 'English', language: 'en' }, { id: 'russian', label: 'Russian', language: 'ru' }, { id: 'media', label: 'Singers', language: 'und' }] });
      portable.writeBundle(next, new Map());
      install(next, new Map(), true); $('new-service').close(); message('Your new service is local to this tab. Add a section or a text slide to begin.');
    } catch (error) { message(error.message); }
  });
  for (const kind of ['section', 'notice', 'blank']) $(kind).addEventListener('click', () => {
    if (!protectDraft()) return;
    try {
      const next = model.add(project, kind, selected); accept(next.project, next.selected); message('Item added. Download your service to keep a copy.');
    } catch (error) { message(error.message); }
  });
  $('edit').addEventListener('input', () => { formDirty = true; pendingDownload = false; $('confirm-download').hidden = true; notify(); });
  $('cancel').addEventListener('click', () => { if (protectDraft()) { formDirty = false; render(); notify(); } });
  $('edit').addEventListener('submit', event => {
    event.preventDefault();
    try {
      const value = project.items[selected], changes = { itemId: selected, title: $('item-title').value, operatorNotes: $('item-notes').value, now: now() };
      const next = model.edit(project, selected, value.kind === 'group' ? changes : { ...changes,
        textByChannel: Object.fromEntries([...$('texts').querySelectorAll('textarea')].filter(text => text.value.trim()).map(text => [text.dataset.channel, text.value])) });
      accept(next); message('Item changes saved in this tab. Download to save a file.');
    } catch (error) { message(error.message); }
  });
  $('undo').addEventListener('click', () => { if (history.length && protectDraft()) { project = history.pop(); selected = null; changed = true; formDirty = false; pendingDownload = false; render(); notify(); } });
  $('download').addEventListener('click', () => {
    if (formDirty) { message('Save or cancel the item changes before downloading.'); return; }
    try {
      const next = core.normalizeServiceProject({ ...clone(project), revision: project.revision + 1, updatedAt: now() });
      const output = portable.writeBundle(next, assets, { fileExtension: $('extension').value });
      const url = URL.createObjectURL(new Blob([output.bytes], { type: 'application/octet-stream' }));
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = output.fileName; document.body.append(anchor); anchor.click(); anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      project = next; changed = true; pendingDownload = true; render(); notify(); message('Download requested. Check that the file was saved, then choose “I saved my download”. Open it through Import service in desktop SyncShow.');
    } catch (error) { message(`Download stopped: ${error.message} Your current service has not changed.`); }
  });
  $('confirm-download').addEventListener('click', () => { if (pendingDownload && !formDirty) { changed = false; pendingDownload = false; render(); notify(); message('Download confirmed. Any new changes will need another download.'); } });
  globalThis.LibreShowWorkspace = Object.freeze({
    state: () => ({ project, assets, selected, changed, formDirty, version: stateVersion, workspaceId }),
    accept, protectDraft, protectService, message, openFile,
    restore(loaded, record) {
      install(loaded.project, loaded.assets, record.unsaved === true);
      selected = loaded.project.items[record.selected] ? record.selected : null; render();
      if (record.pending) {
        $('item-title').value = record.pending.title; $('item-notes').value = record.pending.operatorNotes;
        for (const text of $('texts').querySelectorAll('textarea')) text.value = record.pending.textByChannel[text.dataset.channel] || '';
        formDirty = true; changed = true;
      }
      notify();
    },
  });
  window.addEventListener('beforeunload', event => { if (changed || formDirty) { event.preventDefault(); event.returnValue = ''; } });
})();
