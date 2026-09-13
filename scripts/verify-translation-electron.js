'use strict';
// Opt-in real Electron projection rehearsal with synthetic captions and an
// isolated temporary profile. No microphone, provider calls, or church writes.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process');
  const evidence = fs.mkdtempSync(path.join(os.tmpdir(), 'syncshow-translation-'));
  const env = { ...process.env, SYNCSHOW_TRANSLATION_EVIDENCE: evidence };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(require('electron'), [__filename], { env, stdio: 'inherit', timeout: 90000 });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
} else {
  const { app, BrowserWindow } = require('electron');
  const { TranslationProjection } = require('../src/services/translation/TranslationProjection');
  const { TranslationFeed } = require('../src/services/translation/TranslationFeed');
  const evidence = process.env.SYNCSHOW_TRANSLATION_EVIDENCE;
  assert.ok(evidence && fs.realpathSync(evidence).startsWith(fs.realpathSync(os.tmpdir()) + path.sep));
  app.setPath('userData', path.join(evidence, 'profile'));
  app.commandLine.appendSwitch('disable-background-timer-throttling');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
  const windows = new Map();
  let feed, server;
  const peers = new Set();
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const inspect = win => win.webContents.executeJavaScript(`(() => {
    const el = document.querySelector('.translation-layer');
    const copy = el.firstElementChild;
    const presentation = document.querySelector('#displayContainer, #singerContainer');
    const box = el.getBoundingClientRect();
    return { hidden: getComputedStyle(el).display === 'none', text: copy.textContent,
      layout: el.dataset.layout, lang: el.lang, height: box.height, top: box.top,
      presentationHeight: presentation.getBoundingClientRect().height,
      fontSize: parseFloat(getComputedStyle(el).fontSize),
      scrollHeight: copy.scrollHeight, clientHeight: copy.clientHeight,
      transform: getComputedStyle(copy).transform,
      injected: !!el.querySelector('script, img'),
      guardZ: Number(getComputedStyle(document.getElementById('outputRestoreGuard')).zIndex),
      captionZ: Number(getComputedStyle(el).zIndex) };
  })()`);
  const publicState = { type: 'public-state', state: { active: true, sessionId: 'rehearsal', serverTimeUnixMs: Date.now(),
    languages: [{ language: 'en', available: true }, { language: 'ru', available: true }] } };
  function wire(data) {
    const bytes = Buffer.from(JSON.stringify(data));
    const header = bytes.length < 126 ? Buffer.from([0x81, bytes.length]) : Buffer.from([0x81, 126, bytes.length >> 8, bytes.length & 255]);
    for (const peer of peers) if (!peer.destroyed) peer.write(Buffer.concat([header, bytes]));
  }
  app.whenReady().then(async () => {
    const projection = new TranslationProjection();
    const changed = () => {
      for (const [id, win] of windows) if (!win.isDestroyed()) win.webContents.send('translation:frame', projection.frame(id));
    };
    const results = [];
    for (const [id, page] of [['english', 'display'], ['russian', 'display'], ['stage', 'singer']]) {
      const win = new BrowserWindow({ width: 960, height: 540, useContentSize: true, show: false,
        webPreferences: { preload: path.join(root, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
      await win.loadFile(path.join(root, 'src/renderer', page + '.html'));
      windows.set(id, win);
      win.showInactive();
      if (page === 'display') win.webContents.send('display:init', { language: id, outputId: id, outputName: id, renderer: 'slides', fadeDuration: 0 });
    }
    projection.configure('english', { language: 'en', layout: 'lower-third' });
    projection.configure('russian', { language: 'ru', layout: 'ticker' });
    projection.configure('stage', { language: 'ru', layout: 'full-screen' });
    const http = require('node:http');
    const crypto = require('node:crypto');
    let leaseRequests = 0, scopedRequests = 0;
    server = http.createServer((request, response) => {
      if (request.url === '/admin/live-translation') {
        assert.equal(request.headers.authorization, undefined);
        response.setHeader('content-type', 'text/html');
        response.end(`<title>Local operator rehearsal</title><p id="state">Opening</p><script>
          (async () => {
            const lease = await fetch('/api/community/translation/access', {method:'POST'}).then(r=>r.json());
            const state = await fetch('/translation/api/preflight', {headers:{authorization:'Bearer '+lease.token}}).then(r=>r.json());
            document.getElementById('state').textContent = state.ready ? 'Scoped control connected' : 'Failed';
          })().catch(error => document.getElementById('state').textContent = error.message);
        </script>`);
      } else if (request.url === '/api/community/translation/access') {
        assert.equal(request.headers.authorization, 'SyncShow synthetic-device-token');
        leaseRequests++;
        response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({token:'mlg1.synthetic.signature'}));
      } else if (request.url === '/translation/api/preflight') {
        assert.equal(request.headers.authorization, 'Bearer mlg1.synthetic.signature');
        scopedRequests++;
        response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ready:true}));
      } else { response.writeHead(404); response.end(); }
    });
    let connections = 0;
    server.on('upgrade', (req, socket) => {
      assert.equal(req.url, '/translation/api/public/events');
      assert.equal(req.headers.authorization, undefined);
      connections++;
      const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
      peers.add(socket);
      socket.on('close', () => peers.delete(socket));
      socket.on('error', () => peers.delete(socket));
      wire(publicState);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    feed = new TranslationFeed({ projection, changed });
    feed.connect(`http://127.0.0.1:${server.address().port}`);
    for (let count = 0; projection.snapshot().status !== 'live' && count < 30; count++) await pause(50);
    assert.equal(projection.snapshot().status, 'live');
    const english = 'Grace and peace to you. <script>literal text</script>';
    const russian = 'Благодать вам и мир. «Слово Твоё — светильник ноге моей». ';
    for (const [language, text] of [['en', english], ['ru', russian]]) wire({ type: 'transcript', segment: {
      sessionId: 'rehearsal', channelId: language, language, sequence: 1, text, final: true } });
    await pause(300);
    let en = await inspect(windows.get('english'));
    let ru = await inspect(windows.get('russian'));
    let stage = await inspect(windows.get('stage'));
    assert.equal(en.text, english); assert.equal(en.injected, false);
    assert.equal(ru.text, russian); assert.equal(stage.text, russian);
    assert.ok(en.presentationHeight < en.top + 2, 'slides reserve the caption band');
    assert.ok(en.scrollHeight <= en.clientHeight + 1);
    assert.ok(en.guardZ > en.captionZ);
    const before = ru.transform;
    await pause(180);
    ru = await inspect(windows.get('russian'));
    assert.notEqual(ru.transform, before, 'ticker moves');
    const position = ru.transform;
    wire(publicState); await pause(40);
    assert.notEqual((await inspect(windows.get('russian'))).transform, 'matrix(1, 0, 0, 1, 960, 0)', 'heartbeats do not reset ticker');
    projection.setConnection('disconnected'); changed(); await pause(100);
    const frozen = (await inspect(windows.get('russian'))).transform;
    await pause(200);
    assert.equal((await inspect(windows.get('russian'))).transform, frozen, 'offline freezes scrolling');
    results.push({ name: 'EN/RU, stage, one public socket, literal text, reserved space, frozen ticker', passed: true });
    projection.accept(publicState);
    projection.override('stage', 'Только для сцены'); changed(); await pause(100);
    assert.equal((await inspect(windows.get('stage'))).text, 'Только для сцены');
    assert.equal((await inspect(windows.get('english'))).text, english);
    for (const win of windows.values()) win.webContents.send('display:clear');
    await pause(100);
    wire({ type: 'transcript', segment: { sessionId: 'rehearsal', channelId: 'ru', language: 'ru', sequence: 2, text: 'Новый текст не снимает чёрный экран.', final: true } });
    await pause(100);
    for (const win of windows.values()) assert.equal((await inspect(win)).hidden, true, 'new captions cannot unblack Clear');
    results.push({ name: 'manual stage override and Clear survive new captions', passed: true });
    for (const win of windows.values()) await win.webContents.executeJavaScript("document.querySelector('#displayContainer, #singerContainer').classList.remove('cleared')");
    projection.configure('russian', { language: 'ru', layout: 'lower-third', fontScale: 1.5 });
    const long = russian.repeat(15);
    projection.override('russian', long); changed(); await pause(150);
    ru = await inspect(windows.get('russian'));
    assert.ok(long.startsWith(ru.text) && ru.text.length < long.length && ru.text.length > 10, 'long captions paginate source text');
    assert.ok(ru.scrollHeight <= ru.clientHeight + 1, 'page fits at readable font');
    assert.ok(ru.fontSize >= 30);
    results.push({ name: 'long Russian captions paginate at the selected readable size', passed: true });
    for (const [id, win] of windows) fs.writeFileSync(path.join(evidence, id + '.png'), (await win.webContents.capturePage()).toPNG());
    projection.configure('russian', { language: 'ru', layout: 'hidden' }); changed(); await pause(100);
    assert.equal((await inspect(windows.get('russian'))).hidden, true);
    assert.equal((await inspect(windows.get('english'))).hidden, false);
    assert.equal(connections, 1);
    const { TranslationOperatorWindow } = require('../src/services/translation/TranslationOperatorWindow');
    const operator = new TranslationOperatorWindow({ BrowserWindow });
    await operator.open({ id: 'local-rehearsal', baseUrl: `http://127.0.0.1:${server.address().port}`, accessToken: 'synthetic-device-token' });
    try {
      let text;
      for (let attempt = 0; attempt < 30; attempt++) {
        text = await operator.window.webContents.executeJavaScript("document.getElementById('state').textContent");
        if (text === 'Scoped control connected') break;
        await pause(100);
      }
      assert.equal(text, 'Scoped control connected');
      assert.equal(leaseRequests, 1); assert.equal(scopedRequests, 1);
      assert.equal(await operator.window.webContents.executeJavaScript("typeof require + ':' + typeof window.api"), 'undefined:undefined');
      results.push({ name: 'sandboxed operator window exchanges device token and preserves scoped lease', passed: true });
    } finally { operator.close(); }
    fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify({ passed: true, connections, results }, null, 2));
    console.log(JSON.stringify({ passed: true, evidence, results }));
  }).catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
    feed?.stop();
    for (const peer of peers) peer.destroy();
    server?.close();
    for (const win of windows.values()) if (!win.isDestroyed()) win.destroy();
    app.exit(process.exitCode || 0);
  });
}
