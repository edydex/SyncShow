'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const desktopHtml = fs.readFileSync(path.join(root, 'src', 'renderer', 'index.html'), 'utf8');
const desktopCss = fs.readFileSync(path.join(root, 'src', 'renderer', 'styles.css'), 'utf8');
const remoteHtml = fs.readFileSync(path.join(root, 'src', 'remote', 'index.html'), 'utf8');
const remoteCss = fs.readFileSync(path.join(root, 'src', 'remote', 'remote.css'), 'utf8');
const remoteSource = fs.readFileSync(path.join(root, 'src', 'remote', 'remote.js'), 'utf8');

function captures(source, expression) {
  return [...source.matchAll(expression)].map(match => match[1]);
}

function createRemoteClientHarness(fetch) {
  const window = {
    location: { hash: '', pathname: '/', search: '', origin: 'http://syncshow.test' },
    history: { replaceState() {} },
    fetch,
    setTimeout,
    clearTimeout,
    crypto: globalThis.crypto
  };
  const context = {
    window,
    document: { addEventListener() {}, activeElement: null },
    navigator: { userAgent: 'Test phone' },
    URL,
    URLSearchParams,
    AbortController,
    Uint8Array,
    setTimeout,
    clearTimeout
  };
  vm.runInNewContext(`${remoteSource}\n;globalThis.remoteTest = {
    client, elements, loadCueCatalog, resetCueCatalog, validateState
  };`, context);
  context.remoteTest.elements.jumpDialog = { open: false };
  return context.remoteTest;
}

function remoteCue(index) {
  return {
    index,
    number: index + 1,
    label: `Cue ${index + 1}`,
    text: `Text ${index + 1}`,
    thumbnailUrl: null
  };
}

function compactRemoteState(outputSessionId, totalCues) {
  return {
    protocolVersion: 1,
    revision: 1,
    outputSessionId,
    phase: 'live',
    profileName: 'Sunday service',
    currentCue: totalCues > 0 ? remoteCue(0) : null,
    nextCue: totalCues > 1 ? remoteCue(1) : null,
    totalCues,
    outputs: [],
    controls: { jump: true },
    permissions: {}
  };
}

test('desktop Show exposes an accessible Remote tile, persistent off switch, and pairing dialog', () => {
  assert.match(desktopHtml, /id="btnOpenRemote"[^>]+aria-haspopup="dialog"[^>]+aria-controls="remoteDialog"/);
  assert.match(desktopHtml, /id="remoteLiveStrip"[^>]+hidden/);
  assert.match(desktopHtml, /id="remoteLiveDeviceCount"[^>]+role="status"[^>]+aria-live="polite"/);
  assert.match(desktopHtml, /id="btnRemoteOff"[^>]*>Remote Off</);
  assert.match(desktopHtml, /<dialog id="remoteDialog"[^>]+aria-labelledby="remoteDialogTitle"[^>]+aria-describedby="remoteDialogDescription"/);
  assert.match(desktopHtml, /id="remoteInterfaceSelect"[^>]+aria-describedby="remoteNetworkHelp"/);
  assert.match(desktopHtml, /id="remotePairQr"[^>]+alt="[^"]+"/);
  assert.match(desktopHtml, /id="remotePairCode"[^>]+aria-label="[^"]+"/);
  assert.match(desktopHtml, /id="btnRevokeRemoteDevices"[^>]*>Disconnect all phones</);
  assert.match(desktopHtml, /Only this SyncShow computer can turn Remote on or off or disconnect phones/);
  assert.match(desktopCss, /\.remote-live-strip\s*\{/);
  assert.match(desktopCss, /\.remote-dialog\s*\{/);
  assert.match(desktopCss, /@media \(prefers-reduced-motion: reduce\)/);
});

test('phone Remote uses unique matching DOM ids and no inline or third-party executable content', () => {
  const ids = captures(remoteHtml, /\sid="([^"]+)"/g);
  assert.equal(new Set(ids).size, ids.length, 'phone Remote ids must be unique');

  const idsStart = remoteSource.indexOf('const ids = [');
  const idsEnd = remoteSource.indexOf('];', idsStart);
  const lookedUpIds = captures(remoteSource.slice(idsStart, idsEnd), /'([A-Za-z][A-Za-z0-9]+)'/g);
  for (const id of new Set(lookedUpIds)) {
    assert.ok(ids.includes(id), `phone Remote must provide #${id}`);
  }

  assert.match(remoteHtml, /<link rel="stylesheet" href="\/styles\.css">/);
  assert.match(remoteHtml, /<script src="\/app\.js" defer><\/script>/);
  assert.doesNotMatch(remoteHtml, /<script(?![^>]+src=)/);
  assert.doesNotMatch(remoteHtml, /\sstyle=/);
  assert.doesNotMatch(remoteHtml, /https?:\/\//);
  assert.match(remoteHtml, /Content-Security-Policy[^>]+script-src 'self'[^>]+connect-src 'self'/);
  assert.doesNotMatch(remoteHtml, /unsafe-inline|unsafe-eval/);
});

test('phone pairing consumes and clears the QR fragment and follows the fixed cookie-auth API', () => {
  assert.match(remoteSource, /pair: '\/api\/v1\/pair'/);
  assert.match(remoteSource, /state: '\/api\/v1\/state'/);
  assert.match(remoteSource, /events: '\/api\/v1\/events'/);
  assert.match(remoteSource, /commands: '\/api\/v1\/commands'/);
  assert.match(remoteSource, /cues: '\/api\/v1\/cues'/);
  assert.match(remoteSource, /fragment\.startsWith\('#pair='\)/);
  assert.match(remoteSource, /PAIR_TICKET_PATTERN = \/\^\[A-Za-z0-9_-\]\{43\}\$\//);
  assert.match(remoteSource, /history\.replaceState\(null, '', `\$\{window\.location\.pathname\}\$\{window\.location\.search\}`\)/);
  assert.match(remoteSource, /const body = \{ version: PROTOCOL_VERSION, deviceName:/);
  assert.match(remoteSource, /if \(ticket\) body\.ticket = ticket;\s*else body\.code = code;/);
  assert.match(remoteSource, /credentials: 'same-origin'/);
  assert.match(remoteSource, /'Content-Type'\] = 'application\/json'/);
  assert.match(remoteHtml, /id="deviceName"[^>]+maxlength="48"/);
  assert.doesNotMatch(remoteSource, /slice\(0, 60\)/);
});

test('phone Jump lazily loads a session-scoped paginated cue catalog', () => {
  const validateStateStart = remoteSource.indexOf('function validateState(');
  const validateStateEnd = remoteSource.indexOf('function normalizeCue(', validateStateStart);
  const compactStateValidator = remoteSource.slice(validateStateStart, validateStateEnd);
  assert.doesNotMatch(compactStateValidator, /\bcues:/, 'compact Remote state must not require the cue catalog');

  assert.match(remoteSource, /btnOpenJump\.disabled = [^;]+state\.totalCues === 0/);
  assert.match(remoteSource, /function openJumpDialog\(\)[\s\S]+showModal\(\);[\s\S]+void loadCueCatalog\(\)/);
  assert.match(remoteSource, /new URLSearchParams\(\{[\s\S]+outputSessionId,[\s\S]+offset: String\(offset\),[\s\S]+limit: String\(CUE_CATALOG_PAGE_SIZE\)/);
  assert.match(remoteSource, /requestJson\(`\$\{API\.cues\}\?\$\{query\}`/);
  assert.match(remoteSource, /offset = page\.nextOffset/);
  assert.match(remoteSource, /client\.cueCatalogGeneration \+= 1/);
  assert.match(remoteSource, /cueCatalogLoadIsCurrent\(outputSessionId, generation\)/);
  assert.match(remoteSource, /resetCueCatalog\(state\.outputSessionId, state\.totalCues\)/);
  assert.ok(
    captures(remoteSource, /\b(resetCueCatalog\(\);)/g).length >= 2,
    'pairing and ended views must discard any cached cue catalog'
  );
});

test('phone Jump follows every catalog page and ignores a stale session response', async () => {
  const requests = [];
  const totalCues = 401;
  const harness = createRemoteClientHarness(async requestUrl => {
    const url = new URL(requestUrl, 'http://syncshow.test');
    const offset = Number(url.searchParams.get('offset'));
    const limit = Number(url.searchParams.get('limit'));
    requests.push({ session: url.searchParams.get('outputSessionId'), offset, limit });
    const end = Math.min(offset + limit, totalCues);
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          ok: true,
          outputSessionId: 'show-a',
          totalCues,
          offset,
          nextOffset: end < totalCues ? end : null,
          cues: Array.from({ length: end - offset }, (_value, index) => remoteCue(offset + index))
        };
      }
    };
  });
  const state = harness.validateState(compactRemoteState('show-a', totalCues));
  harness.client.paired = true;
  harness.client.state = state;
  harness.resetCueCatalog(state.outputSessionId, state.totalCues);

  assert.equal(await harness.loadCueCatalog(), true);
  assert.deepEqual(requests, [
    { session: 'show-a', offset: 0, limit: 200 },
    { session: 'show-a', offset: 200, limit: 200 },
    { session: 'show-a', offset: 400, limit: 200 }
  ]);
  assert.equal(harness.client.cueCatalogStatus, 'ready');
  assert.equal(harness.client.cueCatalog.length, totalCues);
  assert.equal(harness.client.cueCatalog.at(-1).index, totalCues - 1);

  let releaseOldPage;
  const staleHarness = createRemoteClientHarness(() => new Promise(resolve => {
    releaseOldPage = resolve;
  }));
  const oldState = staleHarness.validateState(compactRemoteState('show-old', 1));
  staleHarness.client.paired = true;
  staleHarness.client.state = oldState;
  staleHarness.resetCueCatalog(oldState.outputSessionId, oldState.totalCues);
  const pendingLoad = staleHarness.loadCueCatalog();

  const newState = staleHarness.validateState(compactRemoteState('show-new', 1));
  staleHarness.client.state = newState;
  staleHarness.resetCueCatalog(newState.outputSessionId, newState.totalCues);
  releaseOldPage({
    ok: true,
    status: 200,
    async json() {
      return {
        ok: true,
        outputSessionId: 'show-old',
        totalCues: 1,
        offset: 0,
        nextOffset: null,
        cues: [remoteCue(0)]
      };
    }
  });

  assert.equal(await pendingLoad, false);
  assert.equal(staleHarness.client.cueCatalogSessionId, 'show-new');
  assert.equal(staleHarness.client.cueCatalogStatus, 'idle');
  assert.equal(staleHarness.client.cueCatalog.length, 0);
});

test('phone state uses named SSE with polling fallback and never queues or retries commands', () => {
  assert.match(remoteSource, /new window\.EventSource\(API\.events, \{ withCredentials: true \}\)/);
  assert.match(remoteSource, /addEventListener\('state'/);
  assert.doesNotMatch(remoteSource, /addEventListener\('message'/);
  assert.match(remoteSource, /scheduleStatePoll/);
  assert.match(remoteSource, /await refreshState\(\{ quiet: true \}\)/);
  assert.match(remoteSource, /Never resend it/);
  assert.doesNotMatch(remoteSource, /setInterval/);

  for (const type of ['cue.previous', 'cue.next', 'cue.jump', 'output.restore', 'output.clear']) {
    assert.match(remoteSource, new RegExp(type.replace('.', '\\.')));
  }
  for (const field of [
    'version',
    'outputSessionId',
    'sequence',
    'commandId',
    'expectedRevision',
    'expectedCueIndex',
    'command'
  ]) {
    assert.match(remoteSource, new RegExp(`\\b${field}:`));
  }
  assert.match(remoteSource, /client\.commandInFlight/);
  assert.match(remoteSource, /relativeCueCommand \? \(stateAtSend\.currentCue\?\.index \?\? null\) : null/);
  assert.match(remoteSource, /payload\.accepted !== true && payload\.duplicate !== true/);
  assert.match(remoteSource, /applyStatePayload\(payload\)/);
  assert.match(remoteSource, /bytes\[6\] = \(bytes\[6\] & 0x0f\) \| 0x40/);
  assert.match(remoteSource, /bytes\[8\] = \(bytes\[8\] & 0x3f\) \| 0x80/);
  assert.doesNotMatch(remoteSource, /Math\.random/);
});

test('phone rendering uses text nodes and same-origin thumbnail validation', () => {
  assert.doesNotMatch(remoteSource, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\s*\(/);
  assert.match(remoteSource, /\.textContent =/);
  assert.match(remoteSource, /url\.origin !== window\.location\.origin/);
  assert.match(remoteSource, /document\.createElement\('button'\)/);
  assert.match(remoteSource, /setAttribute\('aria-current'/);
  assert.match(remoteCss, /min-height: 48px/);
  assert.match(remoteCss, /@media \(max-width: 330px\)/);
  assert.match(remoteCss, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(remoteCss, /@media \(prefers-contrast: more\)/);
  assert.match(remoteCss, /env\(safe-area-inset-bottom\)/);
  assert.ok(
    remoteHtml.indexOf('id="btnClear"') < remoteHtml.indexOf('id="currentCueCard"'),
    'Clear must be reachable before the full cue preview stack'
  );
});
