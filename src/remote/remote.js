'use strict';

const API = Object.freeze({
  pair: '/api/v1/pair',
  state: '/api/v1/state',
  events: '/api/v1/events',
  commands: '/api/v1/commands',
  cues: '/api/v1/cues'
});

const PROTOCOL_VERSION = 1;
const CUE_CATALOG_PAGE_SIZE = 200;
const LIVE_COMMAND_TIMEOUT_MS = 20_000;
const PAIR_TICKET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const PHASES = new Set(['idle', 'live', 'cleared', 'hidden', 'interrupted']);
const COMMAND_TYPES = new Set([
  'cue.previous',
  'cue.next',
  'cue.jump',
  'output.restore',
  'output.clear'
]);

function readAndClearPairTicket() {
  const fragment = window.location.hash;
  if (!fragment.startsWith('#pair=')) return null;
  const candidate = fragment.slice('#pair='.length);

  // Pairing tickets must not remain in browser history, screenshots of the
  // address bar, referrers, or later requests. Capture once and clear before
  // making any network request.
  window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
  return PAIR_TICKET_PATTERN.test(candidate) ? candidate : '';
}

const initialPairTicket = readAndClearPairTicket();

const client = {
  paired: false,
  pairing: false,
  commandInFlight: false,
  state: null,
  nextSequence: null,
  outputSessionId: null,
  eventSource: null,
  pollTimer: null,
  reconnectStartedAt: null,
  lastAnnouncedCueKey: null,
  cueCatalogSessionId: null,
  cueCatalogTotal: 0,
  cueCatalog: [],
  cueCatalogStatus: 'idle',
  cueCatalogError: '',
  cueCatalogGeneration: 0,
  cueCatalogPromise: null
};

const elements = {};

function setTextIfChanged(element, value) {
  const text = String(value ?? '');
  if (element.textContent !== text) element.textContent = text;
}

class ApiError extends Error {
  constructor(message, status = 0, payload = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.payload = payload;
  }
}

document.addEventListener('DOMContentLoaded', initialize);

function initialize() {
  bindElements();
  setupEventListeners();
  elements.deviceName.value = loadDeviceName();

  if (initialPairTicket !== null) {
    if (!initialPairTicket) {
      showPairingView('That QR code is incomplete. Enter the six-digit code shown on the SyncShow computer.');
      return;
    }
    pairWithCredential({ ticket: initialPairTicket, automatic: true });
    return;
  }

  restoreAuthenticatedSession();
}

function bindElements() {
  const ids = [
    'connectionBadge', 'connectionNotice', 'connectionNoticeText',
    'pairingView', 'pairingDescription', 'ticketPairingProgress', 'pairingForm',
    'deviceName', 'pairCode', 'pairingError', 'btnPair',
    'showEndedView', 'showEndedMessage', 'btnReturnToPairing',
    'showView', 'showTitle', 'healthDetails', 'healthDot', 'healthSummary', 'outputHealthList',
    'showModeBanner', 'showModeIcon', 'showModeTitle', 'showModeDescription',
    'currentCueKicker', 'currentCueHeading', 'currentCueNumber', 'currentCueImage',
    'currentCueImageFallback', 'currentCueText', 'nextCueCard', 'nextCueHeading',
    'nextCueNumber', 'nextCueImage', 'nextCueImageFallback', 'nextCueText',
    'commandStatus', 'commandError', 'btnOpenJump', 'btnPrevious', 'btnNext',
    'btnRestore', 'btnClear', 'jumpDialog', 'btnCloseJump', 'jumpCueList'
  ];

  for (const id of ids) elements[id] = document.getElementById(id);
}

function setupEventListeners() {
  elements.pairingForm.addEventListener('submit', handlePairingSubmit);
  elements.pairCode.addEventListener('input', formatPairCodeInput);
  elements.btnReturnToPairing.addEventListener('click', () => showPairingView());

  elements.btnPrevious.addEventListener('click', () => sendCommand(
    { type: 'cue.previous' },
    'Previous cue'
  ));
  elements.btnNext.addEventListener('click', () => sendCommand(
    { type: 'cue.next' },
    'Next cue'
  ));
  elements.btnRestore.addEventListener('click', () => sendCommand(
    { type: 'output.restore' },
    'Show / Restore outputs'
  ));
  elements.btnClear.addEventListener('click', () => sendCommand(
    { type: 'output.clear' },
    'Clear outputs to black'
  ));

  elements.btnOpenJump.addEventListener('click', openJumpDialog);
  elements.btnCloseJump.addEventListener('click', closeJumpDialog);
  elements.jumpDialog.addEventListener('cancel', event => {
    event.preventDefault();
    closeJumpDialog();
  });
  elements.jumpCueList.addEventListener('click', handleJumpCueClick);

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && client.paired) refreshState({ quiet: true });
  });
  window.addEventListener('beforeunload', stopLiveUpdates);
}

function defaultDeviceName() {
  const userAgent = navigator.userAgent || '';
  if (/iPhone|iPad|iPod/i.test(userAgent)) return 'Apple mobile device';
  if (/Android/i.test(userAgent)) return 'Android phone';
  return 'Phone';
}

function loadDeviceName() {
  try {
    const saved = window.localStorage.getItem('syncshow.remote.deviceName');
    if (typeof saved === 'string' && saved.trim()) return saved.trim().slice(0, 48);
  } catch (_error) {
    // A blocked storage API should never block Remote pairing.
  }
  return defaultDeviceName();
}

function saveDeviceName(deviceName) {
  try {
    window.localStorage.setItem('syncshow.remote.deviceName', deviceName);
  } catch (_error) {
    // Device names are a convenience only; authentication remains cookie-only.
  }
}

function formatPairCodeInput() {
  const digits = elements.pairCode.value.replace(/\D/g, '').slice(0, 6);
  elements.pairCode.value = digits.length > 3
    ? `${digits.slice(0, 3)} ${digits.slice(3)}`
    : digits;
}

async function handlePairingSubmit(event) {
  event.preventDefault();
  const deviceName = elements.deviceName.value.trim().slice(0, 48);
  const code = elements.pairCode.value.replace(/\D/g, '');

  if (!deviceName) {
    showPairingError('Give this phone a short name so the local operator can recognize it.');
    elements.deviceName.focus();
    return;
  }
  if (!/^\d{6}$/.test(code)) {
    showPairingError('Enter all six digits from the SyncShow computer.');
    elements.pairCode.focus();
    return;
  }

  saveDeviceName(deviceName);
  await pairWithCredential({ code, deviceName, automatic: false });
}

async function pairWithCredential({ ticket, code, deviceName = loadDeviceName(), automatic }) {
  if (client.pairing) return;
  client.pairing = true;
  hidePairingError();
  elements.ticketPairingProgress.hidden = !automatic;
  elements.pairingForm.hidden = automatic;
  elements.btnPair.disabled = true;
  setConnection('waiting', automatic ? 'Pairing' : 'Connecting');

  const body = { version: PROTOCOL_VERSION, deviceName: deviceName.trim().slice(0, 48) || 'Phone' };
  if (ticket) body.ticket = ticket;
  else body.code = code;

  try {
    const payload = await requestJson(API.pair, {
      method: 'POST',
      body
    });
    if (payload.ok !== true || payload.paired !== true || !payload.state) {
      throw new ApiError('SyncShow did not confirm pairing.');
    }

    client.paired = true;
    client.nextSequence = validSequence(payload.nextSequence) ? payload.nextSequence : 1;
    client.outputSessionId = null;
    saveDeviceName(body.deviceName);
    applyStatePayload(payload, { allowNewSession: true });
    if (client.paired) startLiveUpdates();
  } catch (error) {
    client.paired = false;
    elements.ticketPairingProgress.hidden = true;
    elements.pairingForm.hidden = false;
    showPairingView(pairingErrorMessage(error));
    window.setTimeout(() => elements.pairCode.focus(), 0);
  } finally {
    client.pairing = false;
    elements.btnPair.disabled = false;
  }
}

async function restoreAuthenticatedSession() {
  setConnection('waiting', 'Connecting');
  try {
    const payload = await requestJson(API.state);
    client.paired = true;
    client.nextSequence = validSequence(payload.nextSequence) ? payload.nextSequence : 1;
    applyStatePayload(payload, { allowNewSession: true });
    if (client.paired) startLiveUpdates();
  } catch (error) {
    if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
      showPairingView();
      return;
    }
    showPairingView('This phone could not reach SyncShow. Check that it is on the same network, then try the code again.');
  }
}

function pairingErrorMessage(error) {
  if (error instanceof ApiError) {
    if (error.status === 429) return 'Too many pairing attempts. Wait a moment, create a new code on SyncShow, and try again.';
    if (error.status === 401 || error.status === 403 || error.status === 410) {
      return 'That pairing code is invalid, expired, or already used. Create a new code on the SyncShow computer.';
    }
    return error.message || 'This phone could not pair with SyncShow.';
  }
  return 'This phone could not reach SyncShow. Check the network and try again.';
}

async function requestJson(url, { method = 'GET', body = null, timeoutMs = 8000 } = {}) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  const options = {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { Accept: 'application/json' },
    signal: controller.signal
  };

  if (body !== null) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }

  try {
    const response = await window.fetch(url, options);
    let payload = null;
    try {
      payload = await response.json();
    } catch (_error) {
      payload = null;
    }

    if (!response.ok || !payload || typeof payload !== 'object') {
      const message = payload?.error?.message
        || (response.ok ? 'SyncShow returned an unreadable response.' : `SyncShow rejected the request (${response.status}).`);
      throw new ApiError(message, response.status, payload);
    }
    return payload;
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new ApiError('SyncShow did not respond in time.');
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

function startLiveUpdates() {
  stopLiveUpdates();
  setConnection('connected', 'Connected');

  if (typeof window.EventSource !== 'function') {
    scheduleStatePoll(0);
    return;
  }

  const eventSource = new window.EventSource(API.events, { withCredentials: true });
  client.eventSource = eventSource;
  eventSource.addEventListener('open', () => {
    if (eventSource !== client.eventSource) return;
    client.reconnectStartedAt = null;
    clearStatePoll();
    setConnection('connected', 'Connected');
  });
  eventSource.addEventListener('state', event => {
    if (eventSource !== client.eventSource) return;
    try {
      const payload = JSON.parse(event.data);
      applyStatePayload(payload);
      if (!client.paired) return;
      client.reconnectStartedAt = null;
      clearStatePoll();
      setConnection('connected', 'Connected');
    } catch (_error) {
      showCommandError('SyncShow sent an unreadable state update. Refreshing safely.');
      scheduleStatePoll(0);
    }
  });
  eventSource.addEventListener('error', () => {
    if (eventSource !== client.eventSource || !client.paired) return;
    if (client.reconnectStartedAt === null) client.reconnectStartedAt = Date.now();
    setConnection('reconnecting', 'Reconnecting', 'Trying to reconnect. Controls are paused, and no action will be sent until SyncShow confirms the connection.');
    renderCommandAvailability();
    scheduleStatePoll(900);
  });
}

function stopLiveUpdates() {
  if (client.eventSource) client.eventSource.close();
  client.eventSource = null;
  clearStatePoll();
}

function clearStatePoll() {
  if (client.pollTimer !== null) window.clearTimeout(client.pollTimer);
  client.pollTimer = null;
}

function scheduleStatePoll(delayMs = 2500) {
  if (!client.paired || client.pollTimer !== null) return;
  client.pollTimer = window.setTimeout(async () => {
    client.pollTimer = null;
    await refreshState({ quiet: true });
    const streamIsOpen = Boolean(
      client.eventSource
      && typeof window.EventSource === 'function'
      && client.eventSource.readyState === window.EventSource.OPEN
    );
    if (client.paired && !streamIsOpen) {
      scheduleStatePoll(2500);
    }
  }, delayMs);
}

async function refreshState({ quiet = false } = {}) {
  if (!client.paired) return false;
  try {
    const payload = await requestJson(API.state, { timeoutMs: 6000 });
    applyStatePayload(payload);
    if (!client.paired) return false;
    setConnection('connected', 'Connected');
    return true;
  } catch (error) {
    if (error instanceof ApiError && (error.status === 401 || error.status === 403 || error.status === 410)) {
      endRemoteAccess(error.message);
      return false;
    }
    setConnection('reconnecting', 'Reconnecting', 'This phone cannot reach SyncShow right now. Local Show control continues normally.');
    if (!quiet) showCommandError('Could not refresh Show state. No command was sent.');
    return false;
  }
}

function applyStatePayload(payload, { allowNewSession = false } = {}) {
  if (!payload || typeof payload !== 'object') throw new Error('Missing Remote payload');
  if (validSequence(payload.nextSequence)) {
    client.nextSequence = client.nextSequence === null
      ? payload.nextSequence
      : Math.max(client.nextSequence, payload.nextSequence);
  }

  const state = validateState(payload.state);
  if (!state) throw new Error('Invalid Remote state');

  if (
    client.outputSessionId !== null
    && state.outputSessionId !== client.outputSessionId
    && !allowNewSession
  ) {
    endRemoteAccess('The SyncShow computer opened a different Show. Pair again to control it.');
    return;
  }

  if (
    client.state
    && client.state.outputSessionId === state.outputSessionId
    && state.revision < client.state.revision
  ) {
    return;
  }

  const catalogIdentityChanged = client.cueCatalogSessionId !== state.outputSessionId
    || client.cueCatalogTotal !== state.totalCues;
  if (catalogIdentityChanged) resetCueCatalog(state.outputSessionId, state.totalCues);

  client.outputSessionId = state.outputSessionId;
  client.state = state;
  client.paired = true;

  if (state.phase === 'idle') {
    endRemoteAccess('This Show is no longer available for Remote control.');
    return;
  }

  showShowView();
  renderState();
}

function validateState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.protocolVersion !== PROTOCOL_VERSION) return null;
  if (!Number.isSafeInteger(value.revision) || value.revision < 0) return null;
  if (typeof value.outputSessionId !== 'string') return null;
  if (!PHASES.has(value.phase)) return null;

  return {
    protocolVersion: PROTOCOL_VERSION,
    revision: value.revision,
    outputSessionId: value.outputSessionId,
    phase: value.phase,
    profileName: safeText(value.profileName),
    currentCue: normalizeCue(value.currentCue),
    nextCue: normalizeCue(value.nextCue),
    totalCues: safeCount(value.totalCues),
    outputs: Array.isArray(value.outputs) ? value.outputs.map(normalizeOutput).filter(Boolean) : [],
    bible: normalizeBible(value.bible),
    controls: normalizeControls(value.controls),
    permissions: value.permissions && typeof value.permissions === 'object' ? value.permissions : {}
  };
}

function normalizeCue(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!Number.isSafeInteger(value.index) || value.index < 0) return null;
  const number = Number.isSafeInteger(value.number) && value.number > 0 ? value.number : value.index + 1;
  return {
    index: value.index,
    number,
    label: safeText(value.label) || `Cue ${number}`,
    text: safeText(value.text),
    thumbnailUrl: sameOriginAssetUrl(value.thumbnailUrl)
  };
}

function normalizeOutput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const id = safeText(value.id);
  const name = safeText(value.name);
  if (!id || !name) return null;
  const health = safeText(value.health || value.status) || 'degraded';
  return { id, name, health };
}

function normalizeBible(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { isLive: false, reference: '', translation: '' };
  }
  return {
    isLive: value.isLive === true || value.phase === 'live',
    reference: safeText(value.reference),
    translation: safeText(value.translation || value.translationId)
  };
}

function normalizeControls(value) {
  const controls = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    previous: controls.previous === true || controls.canPrevious === true,
    next: controls.next === true || controls.canNext === true,
    jump: controls.jump === true || controls.canJump === true || controls.canGoto === true,
    restore: controls.restore === true || controls.canRestore === true,
    clear: controls.clear === true || controls.canClear === true
  };
}

function safeText(value) {
  return typeof value === 'string' ? value.trim().slice(0, 1000) : '';
}

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function validSequence(value) {
  return Number.isSafeInteger(value) && value >= 1;
}

function sameOriginAssetUrl(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value, window.location.origin);
    if (url.origin !== window.location.origin) return null;
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return `${url.pathname}${url.search}`;
  } catch (_error) {
    return null;
  }
}

function renderState() {
  const state = client.state;
  if (!state) return;
  elements.showTitle.textContent = state.profileName || 'Live control';
  renderMode(state);
  renderCue(elements.currentCueHeading, elements.currentCueNumber, elements.currentCueImage,
    elements.currentCueImageFallback, elements.currentCueText, state.currentCue, true, state);
  renderCue(elements.nextCueHeading, elements.nextCueNumber, elements.nextCueImage,
    elements.nextCueImageFallback, elements.nextCueText, state.nextCue, false, state);
  renderOutputHealth(state.outputs, state.phase);
  if (elements.jumpDialog.open) {
    renderJumpCues();
    void loadCueCatalog();
  }
  renderCommandAvailability();
  announceCueChange(state);
}

function renderMode(state) {
  elements.showModeBanner.className = `show-mode-banner is-${state.phase}`;
  elements.currentCueKicker.textContent = 'CURRENT';

  if (state.bible.isLive) {
    elements.showModeIcon.textContent = 'B';
    elements.showModeTitle.textContent = 'Bible passage is live';
    elements.showModeDescription.textContent = [state.bible.reference, state.bible.translation].filter(Boolean).join(' · ')
      || 'Cue navigation is held until the local operator returns to slides.';
    elements.currentCueKicker.textContent = 'BIBLE LIVE';
    return;
  }

  const copy = {
    live: ['●', 'Outputs are live', 'Remote actions apply to the current Show.'],
    cleared: ['■', 'Outputs are black', 'The current cue is staged. Show / Restore will reveal it.'],
    hidden: ['Ⅱ', 'Paused at the SyncShow computer', 'The local operator must restore outputs before phone control continues.'],
    interrupted: ['!', 'Show interrupted', 'An output needs attention at the SyncShow computer.'],
    idle: ['○', 'Show unavailable', 'Pair again after the local operator starts a Show.']
  }[state.phase];
  elements.showModeIcon.textContent = copy[0];
  elements.showModeTitle.textContent = copy[1];
  elements.showModeDescription.textContent = copy[2];
}

function renderCue(heading, numberElement, image, fallback, text, cue, current, state) {
  if (!cue) {
    heading.textContent = current ? 'No current cue' : 'End of service';
    numberElement.textContent = current ? '— / —' : 'End';
    image.hidden = true;
    image.removeAttribute('src');
    fallback.hidden = false;
    fallback.textContent = current ? 'Preview unavailable' : 'No next cue';
    text.textContent = current
      ? 'SyncShow has not provided a current cue.'
      : 'The current cue is the last cue in this Show.';
    return;
  }

  heading.textContent = cue.label;
  const total = state.totalCues;
  numberElement.textContent = current && total > 0 ? `${cue.number} / ${total}` : String(cue.number);
  text.textContent = cue.text || (current ? 'Current cue' : 'Next cue');
  renderCueImage(image, fallback, cue, current ? 'Current' : 'Next');
}

function renderCueImage(image, fallback, cue, position) {
  if (!cue.thumbnailUrl) {
    image.hidden = true;
    image.removeAttribute('src');
    fallback.hidden = false;
    fallback.textContent = 'Preview unavailable';
    return;
  }

  image.onload = () => {
    if (image.src) fallback.hidden = true;
  };
  image.onerror = () => {
    image.hidden = true;
    image.removeAttribute('src');
    fallback.hidden = false;
    fallback.textContent = 'Preview unavailable';
  };
  image.alt = `${position} cue ${cue.number}: ${cue.label}`;
  image.src = cue.thumbnailUrl;
  image.hidden = false;
  fallback.hidden = true;
}

function renderOutputHealth(outputs, phase) {
  elements.outputHealthList.replaceChildren();
  if (outputs.length === 0) {
    elements.healthDot.className = 'health-dot is-attention';
    elements.healthSummary.textContent = 'No output health';
    const empty = document.createElement('li');
    empty.className = 'output-health-item';
    empty.textContent = 'SyncShow has not reported any outputs.';
    elements.outputHealthList.appendChild(empty);
    return;
  }

  const attentionHealth = new Set(['starting', 'degraded', 'missing', 'unavailable', 'interrupted']);
  const attentionCount = outputs.filter(output => attentionHealth.has(output.health)).length;
  elements.healthDot.className = attentionCount === 0 ? 'health-dot is-healthy' : 'health-dot is-attention';
  elements.healthSummary.textContent = attentionCount === 0
    ? `${outputs.length} ${outputs.length === 1 ? 'output' : 'outputs'} healthy`
    : `${attentionCount} ${attentionCount === 1 ? 'output needs' : 'outputs need'} attention`;

  const fragment = document.createDocumentFragment();
  for (const output of outputs) {
    const item = document.createElement('li');
    item.className = 'output-health-item';
    const name = document.createElement('strong');
    name.textContent = output.name;
    const label = document.createElement('span');
    const display = outputHealthLabel(output.health, phase);
    label.className = `output-health-label ${display.attention ? 'is-attention' : 'is-healthy'}`;
    label.textContent = display.text;
    item.append(name, label);
    fragment.appendChild(item);
  }
  elements.outputHealthList.appendChild(fragment);
}

function outputHealthLabel(health, phase) {
  const labels = {
    healthy: { text: phase === 'cleared' ? 'Cleared' : phase === 'hidden' ? 'Hidden' : 'Healthy', attention: false },
    cleared: { text: 'Cleared', attention: false },
    hidden: { text: 'Hidden', attention: false },
    starting: { text: 'Waiting for frame', attention: true },
    degraded: { text: 'Degraded', attention: true },
    missing: { text: 'Missing', attention: true },
    unavailable: { text: 'Unavailable', attention: true },
    interrupted: { text: 'Interrupted', attention: true }
  };
  return labels[health] || { text: 'Needs attention', attention: true };
}

function renderCommandAvailability() {
  const state = client.state;
  const connected = client.paired && elements.connectionBadge.classList.contains('is-connected');
  const available = Boolean(state) && connected && !client.commandInFlight;
  const currentIndex = state?.currentCue?.index;
  const controls = state?.controls || {};

  elements.btnPrevious.disabled = !available || !controls.previous || !(currentIndex > 0);
  elements.btnNext.disabled = !available || !controls.next || !state?.nextCue;
  elements.btnOpenJump.disabled = !available || !controls.jump || state.totalCues === 0;
  elements.btnRestore.disabled = !available || !controls.restore;
  elements.btnClear.disabled = !available || !controls.clear;

  if (!state) return;
  if (client.commandInFlight) {
    elements.commandStatus.classList.add('is-busy');
    return;
  }
  elements.commandStatus.classList.remove('is-busy');
  if (!connected) {
    elements.commandStatus.textContent = 'Controls are paused while this phone reconnects.';
  } else if (state.phase === 'hidden') {
    elements.commandStatus.textContent = 'The local operator paused phone control.';
  } else if (state.phase === 'interrupted') {
    elements.commandStatus.textContent = 'The local operator needs to repair an output before control resumes.';
  } else if (state.bible.isLive) {
    elements.commandStatus.textContent = 'Bible is live. Cue navigation remains with the local operator; Clear is still available.';
  } else {
    elements.commandStatus.textContent = `Ready · Cue ${state.currentCue?.number || '—'} of ${state.totalCues || '—'}`;
  }
}

function syncJumpCueAvailability() {
  const state = client.state;
  for (const button of elements.jumpCueList.querySelectorAll('button[data-cue-index]')) {
    const cueIndex = Number(button.dataset.cueIndex);
    button.disabled = client.commandInFlight || !state?.controls.jump;
    button.setAttribute('aria-current', cueIndex === state?.currentCue?.index ? 'true' : 'false');
  }
}

function resetCueCatalog(outputSessionId = null, totalCues = 0) {
  client.cueCatalogGeneration += 1;
  client.cueCatalogSessionId = outputSessionId;
  client.cueCatalogTotal = totalCues;
  client.cueCatalog = [];
  client.cueCatalogStatus = 'idle';
  client.cueCatalogError = '';
  client.cueCatalogPromise = null;
}

function cueCatalogLoadIsCurrent(outputSessionId, generation) {
  return client.paired
    && client.state?.outputSessionId === outputSessionId
    && client.cueCatalogSessionId === outputSessionId
    && client.cueCatalogGeneration === generation;
}

async function loadCueCatalog() {
  const state = client.state;
  if (!client.paired || !state || state.totalCues === 0) return false;
  if (
    client.cueCatalogSessionId === state.outputSessionId
    && client.cueCatalogTotal === state.totalCues
    && client.cueCatalogStatus === 'ready'
  ) {
    return true;
  }
  if (client.cueCatalogStatus === 'loading' && client.cueCatalogPromise) {
    return client.cueCatalogPromise;
  }
  if (client.cueCatalogStatus === 'error') return false;

  if (
    client.cueCatalogSessionId !== state.outputSessionId
    || client.cueCatalogTotal !== state.totalCues
  ) {
    resetCueCatalog(state.outputSessionId, state.totalCues);
  }

  const outputSessionId = state.outputSessionId;
  const totalCues = state.totalCues;
  const generation = client.cueCatalogGeneration;
  client.cueCatalog = [];
  client.cueCatalogStatus = 'loading';
  client.cueCatalogError = '';
  if (elements.jumpDialog.open) renderJumpCues();

  const loadPromise = loadCueCatalogPages(outputSessionId, totalCues, generation);
  client.cueCatalogPromise = loadPromise;

  try {
    const completed = await loadPromise;
    if (!completed || !cueCatalogLoadIsCurrent(outputSessionId, generation)) return false;
    client.cueCatalogStatus = 'ready';
    if (elements.jumpDialog.open) renderJumpCues();
    return true;
  } catch (error) {
    if (!cueCatalogLoadIsCurrent(outputSessionId, generation)) return false;
    if (error instanceof ApiError && (error.status === 401 || error.status === 403 || error.status === 410)) {
      endRemoteAccess(error.message);
      return false;
    }
    client.cueCatalogStatus = 'error';
    client.cueCatalogError = cueCatalogErrorMessage(error);
    if (elements.jumpDialog.open) renderJumpCues();
    return false;
  } finally {
    if (cueCatalogLoadIsCurrent(outputSessionId, generation)) {
      client.cueCatalogPromise = null;
    }
  }
}

async function loadCueCatalogPages(outputSessionId, totalCues, generation) {
  const catalog = [];
  const visitedOffsets = new Set();
  let offset = 0;

  while (offset !== null) {
    if (!cueCatalogLoadIsCurrent(outputSessionId, generation)) return false;
    if (visitedOffsets.has(offset)) throw new ApiError('SyncShow returned a repeating cue page.');
    visitedOffsets.add(offset);

    const query = new URLSearchParams({
      outputSessionId,
      offset: String(offset),
      limit: String(CUE_CATALOG_PAGE_SIZE)
    });
    const payload = await requestJson(`${API.cues}?${query}`, { timeoutMs: 8000 });
    if (!cueCatalogLoadIsCurrent(outputSessionId, generation)) return false;

    const page = normalizeCueCatalogPage(payload, { outputSessionId, totalCues, offset });
    catalog.push(...page.cues);
    client.cueCatalog = catalog.slice();
    if (elements.jumpDialog.open) renderJumpCues();
    offset = page.nextOffset;
  }

  if (catalog.length !== totalCues) {
    throw new ApiError(`SyncShow returned ${catalog.length} of ${totalCues} cues.`);
  }
  return true;
}

function normalizeCueCatalogPage(payload, { outputSessionId, totalCues, offset }) {
  if (!payload || payload.ok !== true || payload.outputSessionId !== outputSessionId) {
    throw new ApiError('SyncShow returned a cue list for a different Show.');
  }
  if (payload.totalCues !== totalCues || payload.offset !== offset || !Array.isArray(payload.cues)) {
    throw new ApiError('SyncShow returned an inconsistent cue list.');
  }
  if (payload.cues.length > CUE_CATALOG_PAGE_SIZE) {
    throw new ApiError('SyncShow returned too many cues in one page.');
  }

  const cues = payload.cues.map(normalizeCue);
  if (cues.some(cue => !cue)) throw new ApiError('SyncShow returned an invalid cue.');
  for (let position = 0; position < cues.length; position += 1) {
    if (cues[position].index !== offset + position) {
      throw new ApiError('SyncShow returned cues out of order.');
    }
  }

  const expectedNextOffset = offset + cues.length;
  const nextOffset = payload.nextOffset;
  if (nextOffset === null) {
    if (expectedNextOffset !== totalCues) {
      throw new ApiError('SyncShow ended the cue list too early.');
    }
  } else if (
    !Number.isSafeInteger(nextOffset)
    || nextOffset !== expectedNextOffset
    || nextOffset <= offset
    || nextOffset >= totalCues
  ) {
    throw new ApiError('SyncShow returned an invalid next cue page.');
  }

  return { cues, nextOffset };
}

function cueCatalogErrorMessage(error) {
  if (error instanceof ApiError && error.status > 0) {
    return error.message || 'SyncShow could not load the cue list.';
  }
  return 'The cue list could not be loaded. Check the connection and try again.';
}

function appendJumpMessage(message) {
  const notice = document.createElement('p');
  notice.className = 'jump-empty';
  notice.setAttribute('role', 'status');
  notice.textContent = message;
  elements.jumpCueList.appendChild(notice);
}

function appendJumpCatalogError(message) {
  const notice = document.createElement('div');
  notice.className = 'jump-empty';
  notice.setAttribute('role', 'alert');
  const copy = document.createElement('p');
  copy.textContent = message || 'The cue list could not be loaded.';
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'button button-secondary button-small';
  retry.dataset.jumpRetry = 'true';
  retry.textContent = 'Try again';
  notice.append(copy, retry);
  elements.jumpCueList.appendChild(notice);
}

function renderJumpCues() {
  const state = client.state;
  const focusedCueIndex = document.activeElement?.matches?.('button[data-cue-index]')
    ? document.activeElement.dataset.cueIndex
    : null;
  const retryWasFocused = document.activeElement?.matches?.('button[data-jump-retry]') === true;
  elements.jumpCueList.replaceChildren();
  if (!state || state.totalCues === 0) {
    appendJumpMessage('No cue list is available for this Show.');
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const cue of client.cueCatalog) {
    const wrapper = document.createElement('div');
    wrapper.setAttribute('role', 'listitem');

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'jump-cue-button';
    button.dataset.cueIndex = String(cue.index);
    button.setAttribute('aria-current', cue.index === state.currentCue?.index ? 'true' : 'false');
    button.disabled = client.commandInFlight || !state.controls.jump;
    button.setAttribute('aria-label', `Cue ${cue.number}: ${cue.label}`);

    const thumbnail = document.createElement('span');
    thumbnail.className = 'jump-cue-thumbnail';
    if (cue.thumbnailUrl) {
      const image = document.createElement('img');
      image.alt = '';
      image.loading = 'lazy';
      image.src = cue.thumbnailUrl;
      image.addEventListener('error', () => {
        image.remove();
        thumbnail.textContent = String(cue.number);
      });
      thumbnail.appendChild(image);
    } else {
      thumbnail.textContent = String(cue.number);
    }

    const copy = document.createElement('span');
    copy.className = 'jump-cue-copy';
    const heading = document.createElement('strong');
    heading.textContent = `${cue.number}. ${cue.label}`;
    const detail = document.createElement('span');
    detail.textContent = cue.text || 'No extracted text';
    copy.append(heading, detail);
    button.append(thumbnail, copy);
    wrapper.appendChild(button);
    fragment.appendChild(wrapper);
  }
  elements.jumpCueList.appendChild(fragment);

  if (client.cueCatalogStatus === 'loading') {
    const loaded = client.cueCatalog.length;
    appendJumpMessage(loaded > 0
      ? `Loading cues… ${loaded} of ${state.totalCues}`
      : 'Loading cue list…');
  } else if (client.cueCatalogStatus === 'error') {
    appendJumpCatalogError(client.cueCatalogError);
  } else if (client.cueCatalogStatus === 'ready' && client.cueCatalog.length === 0) {
    appendJumpMessage('No cue list is available for this Show.');
  }

  if (focusedCueIndex !== null) {
    const replacement = [...elements.jumpCueList.querySelectorAll('button[data-cue-index]')]
      .find(button => button.dataset.cueIndex === focusedCueIndex);
    if (replacement && !replacement.disabled) replacement.focus({ preventScroll: true });
  } else if (retryWasFocused) {
    elements.jumpCueList.querySelector('button[data-jump-retry]')?.focus({ preventScroll: true });
  }
}

function openJumpDialog() {
  if (elements.btnOpenJump.disabled) return;
  renderJumpCues();
  elements.jumpDialog.showModal();
  void loadCueCatalog();
  window.setTimeout(() => {
    const current = elements.jumpCueList.querySelector('[aria-current="true"]');
    (current || elements.btnCloseJump).focus();
    current?.scrollIntoView({ block: 'center' });
  }, 0);
}

function closeJumpDialog() {
  if (elements.jumpDialog.open) elements.jumpDialog.close();
  elements.btnOpenJump.focus();
}

async function handleJumpCueClick(event) {
  const retry = event.target.closest('button[data-jump-retry]');
  if (retry && !retry.disabled) {
    retry.disabled = true;
    client.cueCatalogStatus = 'idle';
    client.cueCatalogError = '';
    renderJumpCues();
    elements.btnCloseJump.focus({ preventScroll: true });
    await loadCueCatalog();
    return;
  }

  const button = event.target.closest('button[data-cue-index]');
  if (!button || button.disabled) return;
  const cueIndex = Number(button.dataset.cueIndex);
  if (!Number.isSafeInteger(cueIndex) || cueIndex < 0) return;
  const accepted = await sendCommand({ type: 'cue.jump', cueIndex }, `Jump to cue ${cueIndex + 1}`);
  if (accepted) closeJumpDialog();
}

async function sendCommand(command, label) {
  if (client.commandInFlight || !client.state || !client.paired) return false;
  if (!COMMAND_TYPES.has(command?.type)) return false;
  if (!validSequence(client.nextSequence)) {
    showCommandError('SyncShow has not provided a safe command sequence. Refreshing state.');
    await refreshState();
    return false;
  }

  const stateAtSend = client.state;
  const sequenceAtSend = client.nextSequence;
  const relativeCueCommand = command.type === 'cue.previous' || command.type === 'cue.next';
  const commandId = createCommandId();
  if (!commandId) {
    showCommandError('This browser cannot create a safe command ID. Use a current browser or another phone.');
    return false;
  }
  const envelope = {
    version: PROTOCOL_VERSION,
    outputSessionId: stateAtSend.outputSessionId,
    sequence: sequenceAtSend,
    commandId: commandId,
    expectedRevision: stateAtSend.revision,
    expectedCueIndex: relativeCueCommand ? (stateAtSend.currentCue?.index ?? null) : null,
    command: command
  };

  setCommandBusy(true, `${label}…`);
  hideCommandError();
  try {
    const payload = await requestJson(API.commands, {
      method: 'POST',
      body: envelope,
      timeoutMs: LIVE_COMMAND_TIMEOUT_MS
    });
    if (payload.accepted !== true && payload.duplicate !== true) {
      throw new ApiError('SyncShow did not confirm this action.', 0, payload);
    }
    applyStatePayload(payload);
    if (!client.paired) return false;
    elements.commandStatus.textContent = payload.duplicate === true
      ? `${label} was already confirmed. State refreshed.`
      : `${label} confirmed.`;
    return true;
  } catch (error) {
    const payload = error instanceof ApiError ? error.payload : null;
    if (validSequence(payload?.nextSequence)) client.nextSequence = payload.nextSequence;
    if (payload?.state) {
      try {
        applyStatePayload(payload);
      } catch (_stateError) {
        // Preserve the last validated state if an error response is malformed.
      }
    }

    if (error instanceof ApiError && (error.status === 401 || error.status === 403 || error.status === 410)) {
      endRemoteAccess(error.message);
      return false;
    }

    showCommandError(commandErrorMessage(error));
    // A timed-out relative command may have reached SyncShow. Never resend it.
    // Fetch authoritative state and server sequence before another action.
    await refreshState({ quiet: true });
    return false;
  } finally {
    setCommandBusy(false);
  }
}

function commandErrorMessage(error) {
  if (error instanceof ApiError && error.status > 0) {
    return error.message || 'SyncShow rejected this action. State was refreshed.';
  }
  return 'SyncShow did not confirm this action. It was not resent; the current state is being refreshed.';
}

function createCommandId() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    return window.crypto.randomUUID();
  }
  if (window.crypto && typeof window.crypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  return null;
}

function setCommandBusy(busy, message = '') {
  client.commandInFlight = busy;
  elements.commandStatus.classList.toggle('is-busy', busy);
  if (message) elements.commandStatus.textContent = message;
  renderCommandAvailability();
  if (elements.jumpDialog.open) syncJumpCueAvailability();
}

function announceCueChange(state) {
  const cue = state.currentCue;
  if (!cue) return;
  const key = `${state.outputSessionId}:${cue.index}:${state.phase}:${state.bible.isLive}`;
  if (key === client.lastAnnouncedCueKey) return;
  client.lastAnnouncedCueKey = key;

  // The visible current-cue heading is sufficient for sighted operators. This
  // polite update announces the same state without moving keyboard focus.
  const mode = state.bible.isLive ? 'Bible live' : state.phase === 'cleared' ? 'outputs black' : state.phase;
  elements.commandStatus.textContent = `Cue ${cue.number} of ${state.totalCues || '—'}, ${mode}.`;
}

function setConnection(kind, label, notice = '') {
  elements.connectionBadge.className = `connection-badge is-${kind}`;
  setTextIfChanged(elements.connectionBadge, label);
  elements.connectionNotice.hidden = !notice;
  setTextIfChanged(elements.connectionNoticeText, notice);
  renderCommandAvailability();
}

function showPairingView(errorMessage = '') {
  const enteringView = elements.pairingView.hidden;
  stopLiveUpdates();
  client.paired = false;
  client.commandInFlight = false;
  client.state = null;
  client.nextSequence = null;
  client.outputSessionId = null;
  resetCueCatalog();
  elements.pairingView.hidden = false;
  elements.pairingForm.hidden = false;
  elements.ticketPairingProgress.hidden = true;
  elements.showView.hidden = true;
  elements.showEndedView.hidden = true;
  elements.pairCode.value = '';
  setConnection(errorMessage ? 'error' : 'ended', errorMessage ? 'Not connected' : 'Not paired');
  if (errorMessage) showPairingError(errorMessage);
  else hidePairingError();
  if (enteringView) {
    window.requestAnimationFrame(() => {
      if (!elements.pairingView.hidden) elements.deviceName.focus({ preventScroll: true });
    });
  }
}

function showShowView() {
  const enteringView = elements.showView.hidden;
  elements.pairingView.hidden = true;
  elements.showEndedView.hidden = true;
  elements.showView.hidden = false;
  hidePairingError();
  setConnection('connected', 'Connected');
  if (enteringView) {
    window.requestAnimationFrame(() => {
      if (!elements.showView.hidden) elements.btnNext.focus({ preventScroll: true });
    });
  }
}

function endRemoteAccess(message = '') {
  const enteringView = elements.showEndedView.hidden;
  stopLiveUpdates();
  client.paired = false;
  client.commandInFlight = false;
  client.nextSequence = null;
  client.state = null;
  client.outputSessionId = null;
  resetCueCatalog();
  if (elements.jumpDialog.open) elements.jumpDialog.close();
  elements.pairingView.hidden = true;
  elements.showView.hidden = true;
  elements.showEndedView.hidden = false;
  elements.showEndedMessage.textContent = message
    || 'The local operator turned Remote off or opened a different Show. Scan the new QR code on the SyncShow computer to reconnect.';
  setConnection('ended', 'Access ended');
  if (enteringView) {
    window.requestAnimationFrame(() => {
      if (!elements.showEndedView.hidden) elements.btnReturnToPairing.focus({ preventScroll: true });
    });
  }
}

function showPairingError(message) {
  elements.pairingError.textContent = message;
  elements.pairingError.hidden = false;
}

function hidePairingError() {
  elements.pairingError.textContent = '';
  elements.pairingError.hidden = true;
}

function showCommandError(message) {
  elements.commandError.textContent = message;
  elements.commandError.hidden = false;
}

function hideCommandError() {
  elements.commandError.textContent = '';
  elements.commandError.hidden = true;
}
