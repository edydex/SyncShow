'use strict';
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

function audioPermission({ webContents, owner, permission, origin, details, check = false }) {
  if (webContents !== owner || owner.isDestroyed() || permission !== 'media'
    || details?.isMainFrame !== true || !operatorPage(owner.getURL(), origin)
    || !operatorPage(details.requestingUrl, origin)) return false;
  return check ? details.mediaType === 'audio'
    : Array.isArray(details.mediaTypes) && details.mediaTypes.length === 1 && details.mediaTypes[0] === 'audio';
}

class TranslationOperatorWindow {
  constructor({ BrowserWindow, changed = () => {} }) {
    this.BrowserWindow = BrowserWindow;
    this.changed = changed;
    this.window = null;
    this.connectionId = null;
  }

  close() {
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
    this.connectionId = null;
  }

  async open(connection, parent) {
    const origin = communityOrigin(connection.baseUrl);
    if (this.window && !this.window.isDestroyed()) {
      if (this.connectionId === connection.id) { this.window.show(); this.window.focus(); return; }
      this.close();
    }
    const win = new this.BrowserWindow({
      title: 'SyncShow — Live translation', width: 1180, height: 840,
      minWidth: 760, minHeight: 600, parent, show: false, backgroundColor: '#0b1220',
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true,
        backgroundThrottling: false, partition: `syncshow-translation-${require('crypto').randomUUID()}` }
    });
    this.window = win;
    this.connectionId = connection.id;
    const contents = win.webContents;
    const session = contents.session;
    session.setPermissionRequestHandler((webContents, permission, callback, details) => {
      callback(audioPermission({ webContents, owner: contents, permission, origin, details }));
    });
    session.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
      if (requestingOrigin !== origin && requestingOrigin !== `${origin}/`) return false;
      return audioPermission({ webContents, owner: contents, permission, origin, details, check: true });
    });
    session.setDisplayMediaRequestHandler((_request, callback) => callback({}));
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
      await win.loadURL(new URL(OPERATOR_PATH, origin).href);
      if (!win.isDestroyed()) { win.show(); this.changed(); }
    } catch (_error) {
      if (!win.isDestroyed()) win.destroy();
      throw new Error('Live translation could not load. Check the Community connection and try again.');
    }
  }
}

module.exports = { TranslationOperatorWindow, operatorRequestHeaders, audioPermission, operatorPage };
