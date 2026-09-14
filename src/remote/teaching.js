(() => {
  'use strict';
  const panel = document.getElementById('teachingPanel');
  const output = document.getElementById('teachingOutput');
  const tool = document.getElementById('teachingTool');
  const color = document.getElementById('teachingColor');
  const width = document.getElementById('teachingWidth');
  const penOnly = document.getElementById('teachingPenOnly');
  const image = document.getElementById('teachingImage');
  const canvas = document.getElementById('teachingCanvas');
  const wrap = document.getElementById('teachingCanvasWrap');
  const status = document.getElementById('teachingStatus');
  let state, stroke, pointer, pending, sending = false, ready = false, imageFrame = '', refreshBusy = false, previewBusy = false;
  let lastSend = 0, scheduled;
  let localTrail = null, animation = null;
  const shown = () => panel.open && !document.getElementById('showView').hidden;
  const setReady = value => { ready = value; wrap.dataset.ready = String(value); };
  async function json(url, body) {
    const response = await fetch(url, { method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store',
      signal: AbortSignal.timeout(8000), ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error?.message || value.message || (typeof value.error === 'string' ? value.error : 'SyncShow could not confirm this drawing.'));
    return value;
  }
  function clearDraft(keepTrail = false) {
    stroke = null; pointer = null; pending = null;
    if (!keepTrail) localTrail = null;
    if (animation) cancelAnimationFrame(animation);
    animation = null;
    canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
    if (localTrail) paint();
  }
  function accept(next) {
    if (state?.frame && next.frame && state.frame.surfaceId === next.frame.surfaceId && state.frame.outputId === next.frame.outputId
      && Number(next.frame.frameId.split(':').at(-1)) < Number(state.frame.frameId.split(':').at(-1))) return;
    if (state?.frame?.surfaceId !== next.frame?.surfaceId) { clearDraft(); setReady(false); }
    state = next;
    const previous = output.value;
    output.replaceChildren(...next.outputs.map(item => { const option = document.createElement('option'); option.value = item.id; option.textContent = item.name; return option; }));
    if (next.outputs.some(item => item.id === previous)) output.value = previous;
    if (!next.available || !next.frame?.visible) setReady(false);
    status.textContent = next.available ? `${next.cue || 'Current slide'} · Draw on ${output.selectedOptions[0]?.textContent || 'a selected screen'}` : next.message;
  }
  async function preview() {
    if (previewBusy || stroke || pending || sending || !state?.available || !state.frame?.visible || imageFrame === state.frame.frameId) return;
    previewBusy = true;
    const expected = state.frame.frameId, target = output.value;
    try {
      const response = await fetch(`/api/v1/teaching/preview?outputId=${encodeURIComponent(target)}&frameId=${encodeURIComponent(expected)}`, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error('The slide changed. Refreshing its preview…');
      const blob = await response.blob();
      const data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(blob); });
      if (stroke || state?.frame?.frameId !== expected || output.value !== target) return;
      image.onload = () => {
        if (state?.frame?.frameId !== expected || output.value !== target || stroke) return;
        canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
        imageFrame = expected; setReady(true);
      };
      image.src = data;
    } catch (error) { setReady(false); status.textContent = error.message; }
    finally { previewBusy = false; }
  }
  async function refresh() {
    if (!shown() || refreshBusy || sending || stroke) return;
    refreshBusy = true;
    try {
      const selected = output.value;
      const previousSurface = state?.frame?.surfaceId;
      const next = await json(`/api/v1/teaching${selected ? `?outputId=${encodeURIComponent(selected)}` : ''}`);
      if (output.value !== selected || previousSurface !== state?.frame?.surfaceId || stroke) return;
      accept(next);
      if (output.value && (!state.frame || state.frame.outputId !== output.value)) accept(await json(`/api/v1/teaching?outputId=${encodeURIComponent(output.value)}`));
      await preview();
    } catch (error) { clearDraft(); setReady(false); status.textContent = `${error.message} Drawing is paused.`; }
    finally { refreshBusy = false; }
  }
  async function flush() {
    if (sending || !pending) return;
    clearTimeout(scheduled);
    const wait = 110 - (Date.now() - lastSend);
    if (wait > 0) { scheduled = setTimeout(flush, wait); return; }
    const request = pending; pending = null; sending = true; lastSend = Date.now();
    try {
      if (request.stroke.tool === 'pointer') {
        const now = Date.now();
        request.stroke.ages = request.stroke.times.map(time => Math.min(1000, Math.max(0, now - time)));
        delete request.stroke.times;
      }
      const next = await json('/api/v1/teaching', request);
      if (state?.frame?.surfaceId !== request.surfaceId || output.value !== request.outputId) return;
      accept(next);
      if (request.stroke.finished && stroke?.id === request.stroke.id) {
        const transient = stroke.tool === 'pointer';
        clearDraft(transient); if (!transient) setReady(false);
      }
    } catch (error) { clearDraft(); setReady(false); status.textContent = `${error.message} Refreshing; this stroke will not be resent.`; }
    finally { sending = false; if (pending) void flush(); else void preview(); }
  }
  function queue() {
    if (!stroke || !state?.frame) return;
    pending = { operation: 'stroke', outputId: output.value, surfaceId: state.frame.surfaceId,
      stroke: { ...stroke, points: stroke.points.map(point => [...point]), ...(stroke.times ? { times: [...stroke.times] } : {}) } };
    void flush();
  }
  function point(event) {
    const box = canvas.getBoundingClientRect();
    return [Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)), Math.max(0, Math.min(1, (event.clientY - box.top) / box.height))];
  }
  function paint() {
    if (animation) cancelAnimationFrame(animation);
    animation = null;
    const context = canvas.getContext('2d'); context.clearRect(0, 0, canvas.width, canvas.height);
    if (localTrail) {
      if (window.SyncShowTeachingTrail.paintTrail(context, localTrail, canvas.width, canvas.height, Date.now()))
        animation = requestAnimationFrame(paint);
      else localTrail = null;
    }
    if (!stroke || stroke.tool === 'pointer') return;
    context.strokeStyle = stroke.color; context.globalAlpha = stroke.tool === 'highlight' ? .3 : 1;
    context.lineWidth = stroke.width * Math.min(canvas.width, canvas.height); context.lineCap = 'round'; context.lineJoin = 'round'; context.beginPath();
    stroke.points.forEach(([x, y], index) => index ? context.lineTo(x * canvas.width, y * canvas.height) : context.moveTo(x * canvas.width, y * canvas.height));
    context.stroke();
  }
  canvas.addEventListener('pointerdown', event => {
    if (!ready || stroke || sending || !event.isPrimary) return;
    if (penOnly.checked && event.pointerType !== 'pen') {
      status.textContent = 'Stylus only is on. If your pen is not recognized, turn Stylus only off to draw.';
      return;
    }
    const bytes = crypto.getRandomValues(new Uint8Array(16)); bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
    const hex = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
    stroke = { id: `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`,
      tool: tool.value, color: color.value, width: tool.value === 'highlight' ? .035 : Number(width.value), points: [point(event)], finished: false };
    if (stroke.tool === 'pointer') { stroke.times = [Date.now()]; localTrail = stroke; }
    pointer = event.pointerId; canvas.setPointerCapture(pointer); event.preventDefault(); paint(); queue();
  });
  canvas.addEventListener('pointermove', event => {
    if (!stroke || pointer !== event.pointerId || stroke.finished) return;
    const next = point(event), last = stroke.points.at(-1);
    if (Math.hypot(next[0] - last[0], next[1] - last[1]) < .0015) return;
    if (stroke.tool === 'pointer') {
      const now = Date.now();
      while (stroke.points.length >= 128 || (stroke.times.length > 1 && stroke.times[1] < now - 1000)) {
        stroke.points.shift(); stroke.times.shift();
      }
      stroke.points.push(next); stroke.times.push(now); localTrail = stroke;
    } else if (stroke.points.length < 1024) stroke.points.push(next);
    else stroke.finished = true;
    paint(); queue();
  });
  const finish = event => { if (stroke && pointer === event.pointerId) { stroke.finished = true; queue(); } };
  canvas.addEventListener('pointerup', finish); canvas.addEventListener('pointercancel', finish);
  for (const operation of ['undo', 'clear']) document.getElementById(`teaching-${operation}`).addEventListener('click', async () => {
    if (!state?.frame || sending || stroke) return;
    setReady(false); sending = true;
    try { accept(await json('/api/v1/teaching', { operation, outputId: output.value, surfaceId: state.frame.surfaceId })); }
    catch (error) { status.textContent = error.message; }
    finally { sending = false; void preview(); }
  });
  output.addEventListener('change', () => { clearDraft(); setReady(false); imageFrame = ''; void refresh(); });
  document.addEventListener('syncshow:slide-changed', () => {
    clearDraft(); setReady(false); state = null; image.onload = null; imageFrame = ''; void refresh();
  });
  panel.addEventListener('toggle', () => { if (panel.open) void refresh(); else { clearDraft(); setReady(false); } });
  setInterval(() => { if (shown()) void refresh(); else if (stroke) clearDraft(); }, 1500);
})();
