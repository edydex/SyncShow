(function () {
  'use strict';
  const workspace = globalThis.LibreShowWorkspace, model = globalThis.LibreShowEditor;
  const $ = id => document.getElementById(id);
  let index = 0, urls = [], previousItem;
  function preview() {
    const { project, assets, selected } = workspace.state();
    for (const url of urls) URL.revokeObjectURL(url); urls = [];
    $('preview').replaceChildren();
    const present = Boolean(project?.items[selected]);
    $('preview').hidden = !present; $('preview-controls').hidden = !present;
    if (!present) return;
    try {
      const slides = model.preview(project, selected, $('preview-output').value);
      index = Math.max(0, Math.min(index, slides.length - 1));
      $('preview-position').textContent = slides.length ? `${index + 1} / ${slides.length}` : 'No projected content';
      $('preview-previous').disabled = index <= 0; $('preview-next').disabled = index >= slides.length - 1;
      for (const block of slides[index]?.blocks || []) {
        if (typeof block.text === 'string') { const text = document.createElement('p'); text.textContent = block.text; $('preview').append(text); }
        else if (block.type === 'image' && assets.has(block.assetId)) {
          const url = URL.createObjectURL(new Blob([assets.get(block.assetId)], { type: project.assets[block.assetId].mediaType }));
          urls.push(url); const image = document.createElement('img'); image.src = url; image.alt = project.assets[block.assetId].altText || 'Pinned service image'; $('preview').append(image);
        }
      }
    } catch (error) { $('preview').textContent = `Check this preview in desktop SyncShow. ${error.message}`; }
  }
  function refresh() {
    const { project, selected } = workspace.state();
    document.body.classList.toggle('has-service', Boolean(project));
    const present = Boolean(project?.items[selected]); $('order-actions').hidden = !present;
    const oldOutput = $('preview-output').value; $('preview-output').replaceChildren();
    for (const id of project?.channelIds || []) { const option = document.createElement('option'); option.value = id; option.textContent = project.channels[id].label; $('preview-output').append(option); }
    if (project?.channelIds.includes(oldOutput)) $('preview-output').value = oldOutput;
    if (selected !== previousItem) index = 0; previousItem = selected; preview();
  }
  function perform(operation) {
    if (!workspace.protectDraft()) return;
    try { const state = workspace.state(), result = operation(state);
      if (result?.project) workspace.accept(result.project, result.selected);
      else if (result && result !== state.project) workspace.accept(result);
    } catch (error) { workspace.message(error.message); }
  }
  $('move-up').addEventListener('click', () => perform(({ project, selected }) => model.move(project, selected, -1)));
  $('move-down').addEventListener('click', () => perform(({ project, selected }) => model.move(project, selected, 1)));
  $('duplicate').addEventListener('click', () => perform(({ project, selected }) => model.duplicate(project, selected)));
  $('remove').addEventListener('click', () => perform(({ project, selected }) => {
    const count = model.descendants(project, selected).length;
    if (!confirm(`Remove “${project.items[selected].title}”${count > 1 ? ` and its ${count - 1} contained items` : ''}? Undo can restore it.`)) return null;
    return { project: model.remove(project, selected), selected: null };
  }));
  $('preview-output').addEventListener('change', () => { index = 0; preview(); });
  $('preview-previous').addEventListener('click', () => { index -= 1; preview(); });
  $('preview-next').addEventListener('click', () => { index += 1; preview(); });
  document.addEventListener('libreshow:rendered', refresh);
  document.addEventListener('libreshow:state', refresh);
  refresh();
})();
