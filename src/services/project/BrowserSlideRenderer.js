'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { normalizeNativeCueScene, sceneAssetIds } = require('../show/NativeCueScene');

// Use the actual projection renderer when a platform's Pango text metrics
// disagree with Chromium. This window never has the control preload or IPC.
class BrowserSlideRenderer {
  constructor({ BrowserWindow, fontPath, resolveAsset, width = 1920, height = 1080, sharp, rendererDirectory }) {
    this.BrowserWindow = BrowserWindow;
    const font = require('./PresentationFont').fontForPath(fontPath);
    this.fontPath = font.fontPath;
    this.fontFaces = font.faces;
    this.resolveAsset = resolveAsset;
    this.width = width;
    this.height = height;
    this.sharp = sharp || require('sharp');
    this.rendererDirectory = rendererDirectory || path.resolve(__dirname, '../../renderer');
    this.tail = Promise.resolve();
  }

  async initialize() {
    if (this.initializing) return this.initializing;
    this.initializing = (async () => {
      const displayHtml = await fs.readFile(path.join(this.rendererDirectory, 'display.html'), 'utf8');
      const css = displayHtml.match(/<style>([\s\S]*?)<\/style>/)?.[1];
      if (!css) throw new Error('The bundled projection styles are missing.');
      this.win = new this.BrowserWindow({
        show: false, width: this.width, height: this.height, useContentSize: true,
        webPreferences: { offscreen: true, backgroundThrottling: false,
          nodeIntegration: false, contextIsolation: true, sandbox: true, partition: 'native-raster' }
      });
      this.win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      this.win.webContents.on('will-navigate', event => event.preventDefault());
      this.win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      await this.win.loadFile(path.join(this.rendererDirectory, 'native-raster.html'));
      this.win.webContents.setFrameRate(60);
      await this.win.webContents.executeJavaScript(`(async () => {
        const style = document.createElement('style');
        style.textContent = ${JSON.stringify(css)};
        document.head.appendChild(style);
        for (const face of ${JSON.stringify(this.fontFaces.map(face => ({...face,url:pathToFileURL(face.path).href})) )}) {
          const font = new FontFace('SyncShow Presentation', 'url(' + face.url + ')', {weight:face.weight,style:face.style});
          document.fonts.add(await font.load());
        }
        await document.fonts.ready;
      })()`);
    })();
    return this.initializing;
  }

  renderScene(rawScene, { fitOverflow = false } = {}) {
    const task = this.tail.then(() => this._render(rawScene, fitOverflow));
    this.tail = task.catch(() => {});
    return task;
  }

  async _render(rawScene, fitOverflow) {
    const scene = normalizeNativeCueScene(rawScene);
    if (scene.canvas.width !== this.width || scene.canvas.height !== this.height) throw new Error('The slide canvas does not match the renderer.');
    if (fitOverflow) {
      const fit = node => {
        for (const key of ['bodyMinimumSize', 'titleMinimumSize', 'subtitleMinimumSize', 'creditMinimumSize']) {
          if (node.style?.[key] !== undefined) node.style[key] = 14;
        }
        if (node.current) fit(node.current);
      };
      fit(scene);
    }
    const urls = {};
    for (const assetId of sceneAssetIds(scene)) {
      const resolved = await this.resolveAsset(assetId);
      const assetPath = typeof resolved === 'string' ? resolved : resolved?.assetPath;
      if (!path.isAbsolute(assetPath || '')) throw new Error('A slide asset is unavailable.');
      urls[assetId] = pathToFileURL(assetPath).href;
    }
    await this.initialize();
    try {
      await this.win.webContents.executeJavaScript(`(async () => {
        window.rasterView?.destroy();
        const urls = ${JSON.stringify(urls)};
        const view = window.SyncShowNativeCueRenderer.buildScene(${JSON.stringify(scene)}, { resolveAssetUrl: id => urls[id] });
        window.rasterView = view;
        document.body.replaceChildren(view.element);
        await view.prepare();
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      })()`);
      // Offscreen capture can precede the compositor's image paint even after
      // image.decode/layout. Wait for that paint before taking the screenshot.
      await new Promise(resolve => setTimeout(resolve, 150));
      const image = await this.win.webContents.capturePage({ x: 0, y: 0, width: this.width, height: this.height });
      if (image.isEmpty()) throw new Error('The slide renderer returned an empty image.');
      const data = await this.sharp(image.toPNG()).resize(this.width, this.height).jpeg({ quality: 94 }).toBuffer();
      return { info: { data, width: this.width, height: this.height } };
    } catch (cause) {
      const error = new Error(`The projection renderer could not prepare this slide: ${cause.message}`);
      error.code = /fit|overflow|more text/i.test(cause.message) ? 'TEXT_OVERFLOW' : 'TEXT_RENDER_FAILED';
      throw error;
    }
  }

  async dispose() {
    await this.tail;
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
  }
}

module.exports = { BrowserSlideRenderer };
