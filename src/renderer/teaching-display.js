(() => {
  'use strict';
  const parent = document.getElementById('displayContainer');
  if (!parent || !window.api?.onTeachingFrame) return;
  const canvas = document.createElement('canvas');
  canvas.className = 'teaching-ink'; canvas.setAttribute('aria-label', 'Teacher annotations');
  parent.append(canvas);
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
  window.api.onTeachingFrame(value => { frame = value; paint(); });
  addEventListener('resize', paint);
})();
