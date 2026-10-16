'use strict';

function previewDisplayMap(outputs) {
  return new Map(outputs.map(output => {
    const id = `preview-output:${output.id}`;
    return [id, {id, previewOnly: true, bounds: {x: 0, y: 0, width: 1920, height: 1080}}];
  }));
}

// Hidden offscreen renderers are intentionally active, but must never become
// physical output windows, even during Clear/Restore or renderer recovery.
function outputIsPresented(win, enabled) {
  return Boolean(win && !win.isDestroyed() && (win.isVisible() || (win.syncShowPreviewOnly && enabled)));
}

module.exports = {previewDisplayMap, outputIsPresented};
