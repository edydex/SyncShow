'use strict';

// The cached web editor commits a focused field, then waits one animation
// frame before saving. A hidden native view may never receive that frame.
// Bound frames during this flush; preserve single delivery and cancellation.
function flushPlannerEditor(requestId) {
  return new Promise(resolve => {
    const originalFrame = window.requestAnimationFrame;
    const originalCancel = window.cancelAnimationFrame;
    const pending = new Map();
    let finished = false;
    function restoreCancel() {
      if (finished && !pending.size && window.cancelAnimationFrame === cancel) window.cancelAnimationFrame = originalCancel;
    }
    function frame(callback) {
      let id;
      const deliver = timestamp => {
        const entry = pending.get(id);
        if (!entry) return;
        clearTimeout(entry.timer);
        pending.delete(id);
        originalCancel.call(window, id);
        restoreCancel();
        callback(timestamp);
      };
      id = originalFrame.call(window, deliver);
      pending.set(id, { timer: setTimeout(() => deliver(performance.now()), 50) });
      return id;
    }
    function cancel(id) {
      clearTimeout(pending.get(id)?.timer);
      pending.delete(id);
      originalCancel.call(window, id);
      restoreCancel();
    }
    const done = value => {
      finished = true;
      clearTimeout(timeout);
      window.removeEventListener('message', receive);
      if (window.requestAnimationFrame === frame) window.requestAnimationFrame = originalFrame;
      restoreCancel();
      resolve(value);
    };
    function receive(event) {
      if (event.source !== window || event.data?.type !== 'heritage-editor:flushed' || event.data.requestId !== requestId) return;
      done(event.data);
    }
    const timeout = setTimeout(() => done({ ok: false, error: 'Prepare did not confirm its save. Update Community and try again.' }), 30000);
    window.requestAnimationFrame = frame;
    window.cancelAnimationFrame = cancel;
    window.addEventListener('message', receive);
    window.postMessage({ type: 'heritage-editor:flush', requestId }, window.location.origin);
  });
}

module.exports = { flushPlannerEditor };
