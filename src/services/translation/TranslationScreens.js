'use strict';
const path = require('node:path');
const { resolveOutputDisplay } = require('../../renderer/service-output-plan');

/** Local caption windows. Opening a screen never starts capture or provider work. */
class TranslationScreens {
  constructor({ BrowserWindow, projection, context, changed, timeoutMs = 10000 }) {
    Object.assign(this, { BrowserWindow, projection, context, changed, timeoutMs });
    this.windows = new Map();
  }

  availability(outputId, { routingOnly = false } = {}) {
    const context = this.context();
    const output = context.outputs.find(item => item.id === outputId && item.enabled !== false);
    const entry = this.windows.get(outputId);
    const display = resolveOutputDisplay(output, context.displays);
    let reason = '';
    if (!output) reason = 'Choose an output configured for this venue.';
    else if (!routingOnly && context.showActive) reason = 'Show controls the presentation screens.';
    else if (!display) reason = 'Assign a connected screen in Admin Settings.';
    else if (String(display.id) === String(context.controlDisplayId)) reason = 'Choose a screen other than the operator screen.';
    else if ([...this.windows].some(([id, other]) => id !== outputId && other.displayId === String(display.id))) {
      reason = 'Another translation output is already using this screen.';
    } else if (!routingOnly && !entry && this.projection.frame(outputId).layout === 'hidden') {
      reason = 'Choose a visible translation layout first.';
    }
    return { output, display, reason, open: Boolean(entry), ready: entry?.ready === true };
  }

  async open(outputId) {
    const { output, display, reason } = this.availability(outputId);
    if (reason) throw new Error(reason);
    if (this.windows.has(outputId)) return this.windows.get(outputId).opening;
    const win = new this.BrowserWindow({
      ...display.bounds, title: `SyncShow translation — ${output.name || outputId}`,
      frame: false, fullscreen: false, fullscreenable: true, resizable: false,
      movable: false, minimizable: false, maximizable: false, skipTaskbar: true,
      alwaysOnTop: true, backgroundColor: '#000000', focusable: false, show: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true,
        backgroundThrottling: false,
        preload: path.join(__dirname, '../../renderer/translation-screen-preload.js') }
    });
    let cancel;
    const cancelled = new Promise((_, reject) => { cancel = reject; });
    const entry = { win, displayId: String(display.id), bounds: JSON.stringify(display.bounds), ready: false, cancel };
    this.windows.set(outputId, entry);
    win.setIgnoreMouseEvents(true);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
    win.webContents.on('render-process-gone', () => this.close(outputId));
    win.on('unresponsive', () => this.close(outputId));
    win.on('closed', () => {
      if (this.windows.get(outputId) === entry) {
        this.windows.delete(outputId);
        cancel(new Error('The translation screen was closed.'));
        this.changed();
      }
    });
    const timer = setTimeout(() => cancel(new Error('The translation screen did not become ready. Try opening it again.')), this.timeoutMs);
    entry.opening = (async () => {
      try {
        await Promise.race([
          win.loadFile(path.join(__dirname, '../../renderer/translation-screen.html')),
          cancelled
        ]);
        const current = this.availability(outputId);
        if (this.windows.get(outputId) !== entry || current.reason
          || String(current.display?.id) !== entry.displayId
          || JSON.stringify(current.display?.bounds) !== entry.bounds) {
          throw new Error(current.reason || 'Screen assignments changed. Open the translation screen again.');
        }
        entry.ready = true;
        win.webContents.send('translation:frame', this.projection.frame(outputId));
        win.showInactive();
        win.setFullScreen(true);
        win.setAlwaysOnTop(true, 'screen-saver');
        this.changed();
      } catch (error) {
        if (this.windows.get(outputId) === entry) this.close(outputId);
        throw error;
      } finally { clearTimeout(timer); }
    })();
    this.changed();
    return entry.opening;
  }

  close(outputId) {
    const entry = this.windows.get(outputId);
    if (!entry) return;
    this.windows.delete(outputId);
    entry.cancel(new Error('The translation screen was closed.'));
    if (!entry.win.isDestroyed()) entry.win.destroy();
    this.changed();
  }

  closeAll() {
    for (const outputId of [...this.windows.keys()]) this.close(outputId);
  }

  reconcile() {
    for (const [outputId, entry] of this.windows) {
      const current = this.availability(outputId, { routingOnly: true });
      if (current.reason || String(current.display?.id) !== entry.displayId
        || JSON.stringify(current.display?.bounds) !== entry.bounds) this.close(outputId);
    }
  }

  sendFrames() {
    for (const [outputId, entry] of this.windows) {
      if (entry.ready && !entry.win.isDestroyed()) {
        entry.win.webContents.send('translation:frame', this.projection.frame(outputId));
      }
    }
  }
}

module.exports = { TranslationScreens };
