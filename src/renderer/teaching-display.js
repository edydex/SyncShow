(() => {
  'use strict';
  const parent = document.getElementById('displayContainer');
  if (!parent || !window.api?.onTeachingFrame) return;
  const canvas = document.createElement('canvas');
  canvas.className = 'teaching-ink'; canvas.setAttribute('aria-label', 'Teacher annotations');
  parent.append(canvas);
  const trailCanvas = document.createElement('canvas');
  trailCanvas.className = 'teaching-ink teaching-pointer'; parent.append(trailCanvas);
  let trails = [], animation = null;
  function paintTrails() {
    if (animation) cancelAnimationFrame(animation);
    animation = null;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    if (trailCanvas.width !== innerWidth * ratio || trailCanvas.height !== innerHeight * ratio) {
      trailCanvas.width = innerWidth * ratio; trailCanvas.height = innerHeight * ratio;
    }
    const context = trailCanvas.getContext('2d');
    context.setTransform(ratio, 0, 0, ratio, 0, 0); context.clearRect(0, 0, innerWidth, innerHeight);
    trailCanvas.hidden = !frame?.visible;
    trails = frame?.visible ? trails.filter(trail => window.SyncShowTeachingTrail.paintTrail(context, trail, innerWidth, innerHeight, performance.now())) : [];
    if (trails.length) animation = requestAnimationFrame(paintTrails);
  }
  let frame;
  function paint() {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = innerWidth, height = innerHeight;
    canvas.width = width * ratio; canvas.height = height * ratio;
    const context = canvas.getContext('2d'); context.scale(ratio, ratio);
    canvas.hidden = !frame?.visible;
    for (const stroke of frame?.visible ? frame.strokes : []) {
      context.strokeStyle = stroke.color; context.fillStyle = stroke.color;
      context.lineWidth = stroke.width * Math.min(width, height);
      context.globalAlpha = stroke.tool === 'highlight' ? 0.3 : 1;
      context.lineCap = 'round'; context.lineJoin = 'round'; context.beginPath();
      stroke.points.forEach(([x, y], index) => index ? context.lineTo(x * width, y * height) : context.moveTo(x * width, y * height));
      if (stroke.points.length === 1) {
        const [x, y] = stroke.points[0]; context.arc(x * width, y * height, context.lineWidth / 2, 0, Math.PI * 2); context.fill();
      } else context.stroke();
    }
    if (frame) { const frameId = frame.frameId; requestAnimationFrame(() => window.api.teachingFramePainted(frameId)); }
  }
  window.api.onTeachingFrame(value => {
    const changed = frame?.frameId !== value.frameId || frame?.visible !== value.visible;
    frame = value;
    const now = performance.now();
    trails = (value.trails || []).map(trail => ({ ...trail, times: trail.times.map(time => now - (value.serverNow - time)) }));
    if (changed) paint();
    paintTrails();
  });
  addEventListener('resize', () => { paint(); paintTrails(); });
})();
