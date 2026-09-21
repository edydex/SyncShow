(function () {
  'use strict';
  function populateSelect(select, editions) {
    if (!select) return;
    const previous = select.value;
    select.replaceChildren();
    for (const edition of editions) {
      const option = document.createElement('option');
      option.value = edition.id;
      option.textContent = edition.builtin ? edition.id : `${edition.id} · ${edition.name}`;
      select.appendChild(option);
    }
    if (previous && !editions.some(edition => edition.id === previous)) {
      const missing = document.createElement('option');
      missing.value = previous; missing.textContent = `${previous} · unavailable on this computer`; missing.disabled = true;
      select.appendChild(missing);
    }
    select.value = previous || editions[0]?.id || '';
  }
  function initialize({ api, onCatalog }) {
    const byId = id => document.getElementById(`bibleImport${id}`);
    const dialog = byId('Dialog'), open = document.getElementById('btnManageBibleTranslations');
    if (!dialog || !open || !api.listBibleTranslations) return;
    let pending = null, busy = false;
    const message = value => { byId('Status').textContent = value || ''; };
    function controls() {
      for (const name of ['Choose', 'Example', 'Close', 'Permission', 'PermissionReference']) byId(name).disabled = busy;
      byId('Install').disabled = busy || !pending || pending.conflict || !byId('Permission').checked || !byId('PermissionReference').value.trim();
    }
    function reset() {
      pending = null; byId('Preview').hidden = true; byId('Permission').checked = false; byId('PermissionReference').value = ''; controls();
    }
    async function catalog() {
      const result = await api.listBibleTranslations();
      if (result.error) throw new Error(result.error);
      onCatalog(result.translations);
      byId('Catalog').replaceChildren();
      for (const edition of result.translations) {
        const item = document.createElement('li');
        item.textContent = `${edition.id} — ${edition.name}${edition.builtin ? ' · included' : ` · ${edition.verseCount.toLocaleString()} supplied verses`}`;
        byId('Catalog').appendChild(item);
      }
      return result.warnings || [];
    }
    async function run(operation) {
      if (busy) return;
      busy = true; controls();
      try { await operation(); } catch (error) { message(error.message || 'The Bible library could not complete this request.'); }
      finally { busy = false; controls(); }
    }
    open.addEventListener('click', () => {
      reset(); message('Loading installed editions…'); dialog.showModal();
      run(async () => { const warnings = await catalog(); message(warnings.join(' ')); });
    });
    function close() {
      if (busy) return;
      reset(); dialog.close(); api.cancelBibleImport().catch(() => {}); open.focus();
    }
    byId('Close').addEventListener('click', close);
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    byId('Choose').addEventListener('click', () => run(async () => {
      reset(); message('Choose the authorized Bible JSON file.');
      const result = await api.previewBibleImport();
      if (result.cancelled) { message('No file selected.'); return; }
      if (result.error) throw new Error(result.error);
      pending = result;
      const p = result.preview;
      byId('Title').textContent = `${p.name} (${p.id}) · ${p.edition}`;
      byId('Counts').textContent = `${p.language} · ${p.bookCount} books · ${p.chapterCount} chapters · ${p.verseCount.toLocaleString()} supplied verses`;
      byId('Credit').textContent = p.attribution;
      byId('Verses').textContent = `${p.sample.bookId} ${p.sample.chapter}\n${p.sample.verses.map(verse => `${verse.number} ${verse.text}`).join('\n\n')}`;
      byId('License').textContent = `${p.license}\nSource: ${p.sourceUrl}`;
      byId('Preview').hidden = false;
      message(result.conflict ? 'A different edition already uses this ID. Use a new ID; the installed edition is kept.' : result.installed ? 'This exact edition is already installed.' : 'Review the words and permission before installing.');
    }));
    byId('Permission').addEventListener('change', controls);
    byId('PermissionReference').addEventListener('input', controls);
    byId('Form').addEventListener('submit', event => {
      event.preventDefault(); if (!pending || byId('Install').disabled) return;
      run(async () => {
        const result = await api.installBibleImport({ token: pending.token, permissionConfirmed: byId('Permission').checked, permissionReference: byId('PermissionReference').value.trim() });
        if (result.error) throw new Error(result.error);
        reset(); const warnings = await catalog(); message(`${result.id} installed. Select it when adding a Scripture passage. ${warnings.join(' ')}`);
      });
    });
    byId('Example').addEventListener('click', () => run(async () => {
      const result = await api.saveBibleImportExample();
      if (result.error) throw new Error(result.error);
      message(result.saved ? 'Sample saved. Choose that file to try the import workflow.' : 'No sample saved.');
    }));
    catalog().catch(() => {});
  }
  window.SyncShowBibleImports = Object.freeze({ initialize, populateSelect });
}());
