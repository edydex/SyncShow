'use strict';
const path = require('node:path');
const { createHash } = require('node:crypto');
const { communityOrigin } = require('./TranslationFeed');

const ACCESS_PATH = '/api/community/translation/access';
const PLANS_PATH = '/api/community/translation/plans';
const OPERATOR_PATH = '/admin/live-translation';

function operatorPage(url, origin) {
  try {
    const parsed = new URL(url);
    return parsed.origin === origin && parsed.pathname === OPERATOR_PATH && !parsed.username && !parsed.password;
  } catch (_error) { return false; }
}

function operatorRequestHeaders(details, origin, accessToken, webContentsId) {
  const headers = { ...details.requestHeaders };
  const target = new URL(details.url);
  // Retain the operator's short-lived lease only on its same-origin processor
  // API. Permanent device credentials stay on narrowly scoped Community endpoints.
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() !== 'authorization') continue;
    if (target.origin !== origin || !target.pathname.startsWith('/translation/api/')
      || typeof headers[key] !== 'string' || !headers[key].startsWith('Bearer mlg1.')) delete headers[key];
  }
  const serviceIds = target.searchParams.getAll('serviceId');
  const planQuery = [...target.searchParams.keys()].every(key => key === 'serviceId')
    && serviceIds.length <= 1 && serviceIds.every(id => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id));
  const communityRequest = (details.method === 'POST' && target.pathname === ACCESS_PATH && !target.search)
    || (target.pathname === PLANS_PATH && ((details.method === 'GET' && planQuery)
      || (details.method === 'PUT' && !target.search)));
  if (details.webContentsId === webContentsId && communityRequest
    && target.origin === origin && !target.username && !target.password) {
    headers.Authorization = `SyncShow ${accessToken}`;
  }
  return headers;
}

function audioPermission({ webContents, owner, permission, origin, details, check = false, computerAudioSelected = false }) {
  if (webContents !== owner || owner.isDestroyed() || permission !== 'media'
    || details?.isMainFrame !== true || !operatorPage(owner.getURL(), origin)
    || !operatorPage(details.requestingUrl, origin)) return false;
  // Electron 43 reports getDisplayMedia as media with no device mediaTypes.
  // Only the explicitly selected computer source may reach the separately
  // guarded display handler; camera requests still carry video and are denied.
  if (!check && computerAudioSelected && Array.isArray(details.mediaTypes) && details.mediaTypes.length === 0) return true;
  return check ? details.mediaType === 'audio'
    : Array.isArray(details.mediaTypes) && details.mediaTypes.length === 1 && details.mediaTypes[0] === 'audio';
}

class TranslationOperatorWindow {
  constructor({ BrowserWindow, desktopCapturer, changed = () => {}, failed = () => {}, readyTimeoutMs = 15000, stopTimeoutMs = 55000 }) {
    this.BrowserWindow = BrowserWindow;
    this.desktopCapturer = desktopCapturer;
    this.computerAudioSelected = false;
    this.changed = changed;
    this.failed = failed;
    this.readyTimeoutMs = readyTimeoutMs;
    this.stopTimeoutMs = stopTimeoutMs;
    this.readyTimer = null;
    this.stopWaiter = null;
    this.stopPending = null;
    this.lastStatus = 'idle';
    this.window = null;
    this.connectionId = null;
    this.command = null;
    this.ready = false;
  }

  owns(event) {
    return this.window && !this.window.isDestroyed() && event.sender === this.window.webContents
      && event.senderFrame === event.sender.mainFrame && operatorPage(event.sender.getURL(), this.origin);
  }
  dispatch(command) {
    this.command = command;
    if (this.ready && this.window && !this.window.isDestroyed()) this.window.webContents.send('translation:cue-command', command);
    else if (!this.ready && command.phase !== 'idle' && !this.readyTimer) {
      this.readyTimer = setTimeout(() => {
        this.readyTimer = null;
        this.failed('Translation controls did not become ready. Open Translation controls to check the connection and processor version.');
      }, this.readyTimeoutMs);
      this.readyTimer.unref?.();
    } else if (command.phase === 'idle') { clearTimeout(this.readyTimer); this.readyTimer = null; }
  }
  markReady() { clearTimeout(this.readyTimer); this.readyTimer = null; this.ready = true; if (this.command) this.dispatch(this.command); }
  report(status) {
    this.lastStatus = status.phase;
    if (status.phase === 'idle') this.stopWaiter?.();
    else if (status.phase === 'error') this.stopWaiter?.(new Error(status.message || 'Translation Stop was not confirmed.'));
  }
  stop(command = this.command) {
    if (this.stopPending) return this.stopPending;
    if (!command || !this.window || this.window.isDestroyed()) return Promise.resolve();
    if (this.command?.phase === 'idle' && this.lastStatus === 'idle') return Promise.resolve();
    this.stopPending = new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('The translation server did not confirm Stop. Retry Stop or check Live translation on the Community server.')), this.stopTimeoutMs);
      const finish = error => {
        clearTimeout(timer); this.stopWaiter = null;
        if (error) { this.failed(error.message); reject(error); } else resolve();
      };
      this.stopWaiter = finish;
      // Queue Stop even if the operator page is still loading: a late Ready
      // must never dispatch the obsolete Start that this command replaces.
      this.dispatch({ ...command, phase: 'idle' });
    }).finally(() => { this.stopPending = null; });
    return this.stopPending;
  }
  async shutdown() {
    try { await this.stop(); } finally { this.close(); }
  }

  close() {
    clearTimeout(this.readyTimer); this.readyTimer = null;
    this.stopWaiter?.(new Error('Translation controls closed before Stop was confirmed.'));
    this.command = null; this.ready = false; this.origin = null;
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
    this.connectionId = null;
  }

  async open(connection, parent, { hidden = false, serviceId } = {}) {
    const origin = communityOrigin(connection.baseUrl);
    if (this.window && !this.window.isDestroyed()) {
      if (this.connectionId === connection.id && this.origin === origin) { if (!hidden) { this.window.show(); this.window.focus(); } return; }
      await this.shutdown();
    }
    const win = new this.BrowserWindow({
      title: 'SyncShow — Live translation', width: 1180, height: 840,
      minWidth: 760, minHeight: 600, parent, show: false, backgroundColor: '#0b1220',
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true,
        preload: path.join(__dirname, '../../renderer/translation-operator-preload.js'),
        autoplayPolicy: 'no-user-gesture-required', backgroundThrottling: false,
        partition: `persist:syncshow-translation-${createHash('sha256').update(connection.id).digest('hex')}` }
    });
    this.window = win;
    this.connectionId = connection.id;
    this.origin = origin;
    this.ready = false;
    const contents = win.webContents;
    contents.on('did-start-loading', () => { this.ready = false; });
    contents.on('render-process-gone', () => {
      if (this.command?.phase && this.command.phase !== 'idle') this.failed('Translation controls stopped unexpectedly. Check Live translation before restarting.');
      this.close();
    });
    // Closing the controls must not kill a running cue-owned audio input.
    win.on('close', event => { if (this.command?.phase !== 'idle' && this.command) { event.preventDefault(); win.hide(); } });
    const session = contents.session;
    session.setPermissionRequestHandler((webContents, permission, callback, details) => {
      if(permission==='display-capture') return callback(Boolean(this.computerAudioSelected && webContents===contents && details?.isMainFrame===true && operatorPage(contents.getURL(),origin) && operatorPage(details.requestingUrl,origin)));
      callback(audioPermission({ webContents, owner: contents, permission, origin, details, computerAudioSelected: this.computerAudioSelected }));
    });
    session.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
      if (requestingOrigin !== origin && requestingOrigin !== `${origin}/`) return false;
      if(permission==='display-capture') return Boolean(this.computerAudioSelected && webContents===contents && details?.isMainFrame===true && operatorPage(contents.getURL(),origin) && operatorPage(details.requestingUrl,origin));
      return audioPermission({ webContents, owner: contents, permission, origin, details, check: true });
    });
    session.setDisplayMediaRequestHandler(async (request, callback) => {
      if (!this.computerAudioSelected || !request.audioRequested || !this.owns({sender:contents,senderFrame:request.frame})
        || !operatorPage(request.frame?.url,origin) || request.frame!==contents.mainFrame || !this.desktopCapturer) return callback({});
      try {
        const sources = await this.desktopCapturer.getSources({types:['screen'],thumbnailSize:{width:0,height:0}});
        if(this.window!==win || win.isDestroyed() || !this.computerAudioSelected || !sources.length)return callback({});
        callback({video:sources[0],audio:'loopback'});
      } catch { callback({}); }
    });
    session.webRequest.onBeforeSendHeaders({ urls: ['<all_urls>'] }, (details, callback) => {
      callback({ requestHeaders: operatorRequestHeaders(details, origin, connection.accessToken, contents.id) });
    });
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    const restrict = (event, url) => { if (!operatorPage(url, origin)) event.preventDefault(); };
    contents.on('will-navigate', restrict);
    contents.on('will-redirect', restrict);
    contents.on('will-attach-webview', event => event.preventDefault());
    session.on('will-download', event => event.preventDefault());
    win.on('closed', () => {
      session.webRequest.onBeforeSendHeaders(null);
      session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
      session.setPermissionCheckHandler(() => false);
      if (this.window === win) { this.window = null; this.connectionId = null; }
      this.changed();
    });
    try {
      const url = new URL(OPERATOR_PATH, origin);
      if (serviceId) url.searchParams.set('service', serviceId);
      await win.loadURL(url.href);
      if (!win.isDestroyed()) { if (!hidden) win.show(); this.changed(); }
    } catch (_error) {
      if (!win.isDestroyed()) win.destroy();
      throw new Error('Live translation could not load. Check the Community connection and try again.');
    }
  }
}

module.exports = { TranslationOperatorWindow, operatorRequestHeaders, audioPermission, operatorPage };
