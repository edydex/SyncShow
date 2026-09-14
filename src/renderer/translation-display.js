/* Final captions only. No network, microphone, HTML injection, or session control. */
(() => {
  'use strict';
  const container = document.getElementById('displayContainer') || document.getElementById('singerContainer');
  const layer = document.createElement('section');
  layer.className = 'translation-layer';
  layer.hidden = true;
  layer.setAttribute('aria-label', 'Live translation');
  const copy = document.createElement('div');
  copy.className = 'translation-copy';
  layer.append(copy);
  container.append(layer);
  let frame = null;
  let identity = '';
  let seen = new Map();
  let queue = [];
  let current = null;
  let pages = [];
  let page = 0;
  let elapsed = 0;
  let x = 0;
  let lastTime = 0;
  let history = [];

  // Measure at the chosen readable font size; paginate without dropping text.
  function paginate(text) {
    const points = Array.from(text);
    const result = [];
    let offset = 0;
    while (offset < points.length) {
      let low = 1, high = points.length - offset, fit = 1;
      while (low <= high) {
        const count = Math.floor((low + high) / 2);
        copy.textContent = points.slice(offset, offset + count).join('');
        if (copy.scrollHeight <= copy.clientHeight + 1) { fit = count; low = count + 1; }
        else high = count - 1;
      }
      if (offset + fit < points.length) {
        const candidate = points.slice(offset, offset + fit).join('');
        const breakAt = Math.max(candidate.lastIndexOf(' '), candidate.lastIndexOf('\n'));
        if (breakAt > candidate.length / 2) fit = Array.from(candidate.slice(0, breakAt + 1)).length;
      }
      result.push(points.slice(offset, offset + fit).join(''));
      offset += fit;
    }
    return result;
  }

  function showPage() {
    copy.replaceChildren();
    copy.style.transform = '';
    if (!current) return;
    if (frame.layout === 'ticker') {
      copy.textContent = current.text.replace(/\r?\n/g, ' ');
      copy.style.transform = `translateX(${x}px)`;
      return;
    }
    const latest = document.createElement('p');
    latest.textContent = pages[page] || '';
    copy.append(latest);
    // Full-screen keeps as much preceding text as fits, newest at the bottom.
    if (frame.layout === 'full-screen' && pages.length === 1) {
      for (const previous of history.slice(-7).reverse()) {
        const paragraph = document.createElement('p');
        paragraph.textContent = previous.text;
        copy.prepend(paragraph);
        if (copy.scrollHeight > copy.clientHeight + 1) { paragraph.remove(); break; }
      }
    }
  }

  function startNext() {
    if (!queue.length) return;
    if (current) history = [...history, current].slice(-7);
    current = queue.shift();
    page = 0;
    elapsed = 0;
    x = layer.clientWidth;
    pages = frame.layout === 'ticker' ? [current.text] : paginate(current.text);
    showPage();
  }

  function receive(next) {
    if (!next || !['hidden', 'full-screen', 'lower-third', 'ticker'].includes(next.layout)) return;
    const nextIdentity = `${next.outputId}:${next.sessionId}:${next.language}:${next.layout}:${next.manual ? next.phrases[0]?.key : false}`;
    if (identity !== nextIdentity) {
      identity = nextIdentity;
      seen = new Map(); queue = []; current = null; history = []; pages = [];
      copy.replaceChildren();
    }
    const oldScale = frame?.fontScale;
    frame = next;
    layer.dataset.layout = next.layout;
    layer.lang = next.language;
    layer.hidden = next.layout === 'hidden';
    document.documentElement.style.setProperty('--translation-font', String(next.fontScale));
    const band = next.layout === 'ticker' ? '12vh' : next.layout === 'lower-third' ? '29vh' : '0px';
    document.documentElement.style.setProperty('--translation-band', band);
    document.documentElement.style.setProperty('--translation-content-scale', next.layout === 'ticker' ? '0.88' : next.layout === 'lower-third' ? '0.71' : '1');
    if (next.layout === 'hidden') return;
    if (!next.phrases.length) { current = null; queue = []; history = []; copy.replaceChildren(); }
    if (!seen.size && next.phrases.length) {
      // A screen joining mid-sermon starts at the current phrase. History is
      // useful in the full-screen feed, but must not become a delayed ticker.
      for (const phrase of next.phrases.slice(0, -1)) seen.set(phrase.key, phrase.revision);
      history = next.phrases.slice(0, -1).slice(-7);
    }
    for (const phrase of next.phrases) {
      if (seen.has(phrase.key) && seen.get(phrase.key) >= phrase.revision) continue;
      seen.set(phrase.key, phrase.revision);
      if (current?.key === phrase.key) {
        current = phrase;
        pages = next.layout === 'ticker' ? [phrase.text] : paginate(phrase.text);
        page = Math.min(page, pages.length - 1);
        showPage();
      } else {
        const index = queue.findIndex(item => item.key === phrase.key);
        if (index >= 0) queue[index] = phrase;
        else if (!history.some(item => item.key === phrase.key)) queue.push(phrase);
      }
    }
    // Bound memory and catch up after a prolonged renderer stall.
    seen = new Map([...seen].slice(-160));
    queue = queue.slice(-12);
    if (!current) startNext();
    else if (oldScale !== next.fontScale && next.layout !== 'ticker') {
      pages = paginate(current.text); page = Math.min(page, pages.length - 1); showPage();
    }
  }

  function tick(time) {
    const delta = Math.min(100, Math.max(0, time - lastTime));
    lastTime = time;
    if (current && frame?.moving && !layer.hidden && !container.classList.contains('cleared')) {
      if (frame.layout === 'ticker') {
        x -= delta / 1000 * Math.max(30, innerHeight * 0.085 * frame.fontScale);
        copy.style.transform = `translateX(${x}px)`;
        if (x < -copy.scrollWidth) {
          if (queue.length) startNext();
          else { copy.textContent = ''; current = null; }
        }
      } else {
        elapsed += delta;
        const duration = Math.max(4000, Math.min(16000, (pages[page]?.length || 0) * 55));
        if (elapsed >= duration) {
          if (page + 1 < pages.length) { page++; elapsed = 0; showPage(); }
          else if (queue.length) startNext();
        }
      }
    }
    requestAnimationFrame(tick);
  }
  new ResizeObserver(() => {
    if (current && frame.layout !== 'ticker') {
      pages = paginate(current.text); page = Math.min(page, pages.length - 1); showPage();
    }
  }).observe(layer);
  window.api.onTranslationFrame(receive);
  requestAnimationFrame(tick);
})();
