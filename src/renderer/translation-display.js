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

  // ICU handles English/Russian punctuation, quotations and decimal numbers.
  // Join common honorifics that ICU treats as standalone sentences.
  function sentences(text) {
    const result = [];
    let pending = '';
    for (const { segment } of new Intl.Segmenter(frame.language, { granularity: 'sentence' }).segment(text)) {
      pending += segment;
      if (/(?:\b(?:Mr|Mrs|Ms|Dr|Prof|Rev|St|Sr|Jr)|(?<!\p{L})[A-ZА-ЯЁ])\.\s*$/u.test(pending.trim())) continue;
      if (pending.trim()) result.push(pending.trim());
      pending = '';
    }
    if (pending.trim()) result.push(pending.trim());
    return result;
  }

  // Keep a sentence intact when it fits. Only unusually long sentences need
  // continuation pages, measured at the chosen font size without dropping text.
  function paginateSentence(text) {
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

  function paginate(text) {
    let offset = 0;
    return sentences(text).flatMap(sentence => paginateSentence(sentence).map(part => {
      const page = { text: part, offset };
      offset += part.length;
      return page;
    }));
  }

  function repaginate() {
    const offset = pages[page]?.offset ?? 0;
    pages = paginate(current.text);
    // Resizing must not replay the beginning of a translated paragraph.
    page = Math.max(0, pages.findLastIndex(part => part.offset <= offset));
    showPage();
  }

  function rememberPage() {
    if (pages[page]?.text) history = [...history, { text: pages[page].text }].slice(-7);
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
    const latest = document.createElement('span');
    latest.className = 'translation-sentence current';
    latest.setAttribute('aria-current', 'true');
    latest.textContent = pages[page]?.text || '';
    copy.append(latest);
    // A rolling paragraph in both sentence layouts: old sentences are gray,
    // the current sentence is white, and the oldest leaves when space runs out.
    for (const previous of history.slice().reverse()) {
      const sentence = document.createElement('span');
      sentence.className = 'translation-sentence previous';
      sentence.textContent = previous.text.trimEnd() + ' ';
      copy.prepend(sentence);
      if (copy.scrollHeight > copy.clientHeight + 1) { sentence.remove(); break; }
    }
  }

  function startNext() {
    if (!queue.length) return;
    if (current && frame.layout !== 'ticker') rememberPage();
    current = queue.shift();
    page = 0;
    elapsed = 0;
    x = layer.clientWidth;
    pages = frame.layout === 'ticker' ? [] : paginate(current.text);
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
    const band = next.layout === 'ticker' ? 'calc(12 * var(--output-vh, 1vh))' : next.layout === 'lower-third' ? 'calc(29 * var(--output-vh, 1vh))' : '0px';
    document.documentElement.style.setProperty('--translation-band', band);

    if (next.layout === 'hidden') return;
    if (!next.phrases.length) { current = null; queue = []; history = []; seen.clear(); copy.replaceChildren(); }
    if (!seen.size && next.phrases.length) {
      // A screen joining mid-sermon starts at the current phrase. History is
      // useful in the full-screen feed, but must not become a delayed ticker.
      for (const phrase of next.phrases.slice(0, -1)) seen.set(phrase.key, phrase.revision);
      history = next.phrases.slice(0, -1).flatMap(phrase => sentences(phrase.text).map(text => ({ text }))).slice(-7);
    }
    for (const phrase of next.phrases) {
      if (seen.has(phrase.key) && seen.get(phrase.key) >= phrase.revision) continue;
      const alreadyReceived = seen.has(phrase.key);
      seen.set(phrase.key, phrase.revision);
      if (current?.key === phrase.key) {
        current = phrase;
        if (next.layout === 'ticker') showPage();
        else repaginate();
      } else {
        const index = queue.findIndex(item => item.key === phrase.key);
        if (index >= 0) queue[index] = phrase;
        else if (!alreadyReceived) queue.push(phrase);
      }
    }
    // Bound memory and catch up after a prolonged renderer stall.
    seen = new Map([...seen].slice(-160));
    queue = queue.slice(-12);
    if (!current) startNext();
    else if (oldScale !== next.fontScale && next.layout !== 'ticker') {
      repaginate();
    }
  }

  function tick(time) {
    const delta = Math.min(100, Math.max(0, time - lastTime));
    lastTime = time;
    if (current && frame?.moving && !layer.hidden && !container.classList.contains('cleared')) {
      if (frame.layout === 'ticker') {
        x -= delta / 1000 * Math.max(30, document.body.clientHeight * 0.085 * frame.fontScale);
        copy.style.transform = `translateX(${x}px)`;
        if (x < -copy.scrollWidth) {
          if (queue.length) startNext();
          else { copy.textContent = ''; current = null; }
        }
      } else {
        elapsed += delta;
        const words = (pages[page]?.text || '').trim().split(/\s+/u).length;
        // Roughly 250 words/minute; no paragraph-sized minimum dwell. Waiting
        // for another sentence leaves this one visible rather than clearing it.
        const duration = Math.max(1500, Math.min(9500, words * 240 + 500));
        if (elapsed >= duration) {
          if (page + 1 < pages.length) { rememberPage(); page++; elapsed = 0; showPage(); }
          else if (queue.length) startNext();
        }
      }
    }
    requestAnimationFrame(tick);
  }
  new ResizeObserver(() => {
    if (current && frame.layout !== 'ticker') {
      repaginate();
    }
  }).observe(layer);
  window.api.onTranslationFrame(receive);
  requestAnimationFrame(tick);
})();
