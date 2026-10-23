(function (root) {
  'use strict';
  const core = root.SyncShowCore;
  const freshId = () => `browser-${root.SyncShowSharedRuntime.crypto.randomUUID()}`;
  function editableText(item) {
    return item?.kind === 'notice' && !item.spansByChannel && !item.titleSpansByChannel
      && !item.sermonTemplate && !item.canvasObjects;
  }
  function add(project, kind, selected, now = new Date().toISOString()) {
    const id = freshId(), parentId = project.items[selected]?.kind === 'group' ? selected : null;
    const next = kind === 'section' ? core.addGroupItem(project, { id, title: 'New section', parentId, now })
      : core.addProjectItem(project, { id, kind, title: kind === 'notice' ? 'New text slide' : 'Blank',
        operatorNotes: '', createdAt: now, updatedAt: now,
        ...(kind === 'notice' ? { textByChannel: { [project.channelIds[0]]: 'Your text here' }, presetId: 'notice-text' }
          : { presetId: 'blank-black' }) }, { parentId, now });
    return { project: next, selected: id };
  }
  function edit(project, selected, values, now = new Date().toISOString()) {
    const item = project.items[selected];
    const changes = { ...values, itemId: selected, now };
    if (item?.kind === 'group') return core.updateGroupItem(project, changes);
    if (editableText(item)) return core.updateTextItem(project, changes);
    throw new Error('This content is preserved; use desktop SyncShow to edit it.');
  }
  function siblings(project, selected) {
    const parent = project._index.parentByItemId[selected];
    return { parent, ids: parent === null ? project.rootItemIds : project.items[parent].childIds };
  }
  function move(project, selected, direction) {
    const { parent, ids } = siblings(project, selected);
    const index = ids.indexOf(selected), targetIndex = index + direction;
    if (index < 0 || targetIndex < 0 || targetIndex >= ids.length) return project;
    return core.moveProjectItem(project, { itemId: selected, targetParentId: parent, targetIndex });
  }
  function duplicate(project, selected) {
    const { parent, ids } = siblings(project, selected), index = ids.indexOf(selected);
    const next = core.duplicateProjectItem(project, { itemId: selected });
    const nextIds = parent === null ? next.rootItemIds : next.items[parent].childIds;
    return { project: next, selected: nextIds[index + 1] };
  }
  function descendants(project, selected) {
    return [selected, ...(project.items[selected]?.childIds || []).flatMap(id => descendants(project, id))];
  }
  function preview(project, selected, channelId) {
    const itemIds = new Set(descendants(project, selected));
    const timeline = core.compileServiceProject(project);
    return timeline.cueIds.filter(id => itemIds.has(timeline.cues[id].itemId)).map(id => {
      let channel = timeline.cues[id].channels[channelId];
      while (channel?.mode === 'inherit') channel = timeline.cues[id].channels[channel.from];
      return { id, blocks: channel?.blocks || [] };
    });
  }
  root.LibreShowEditor = Object.freeze({ freshId, editableText, add, edit, move, duplicate, descendants, preview,
    remove: (project, selected) => core.removeProjectItemAndDescendants(project, selected) });
})(globalThis);
