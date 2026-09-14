// Shared by the tablet and projector. Only animate while a one-second trail exists.
(function (root) {
  'use strict';
  function paintTrail(context, trail, width, height, now) {
    const cutoff = now - 1000;
    if (!trail.times.length || trail.times.at(-1) <= cutoff) return false;
    context.strokeStyle = context.fillStyle = trail.color;
    context.lineWidth = trail.width * Math.min(width, height);
    context.lineCap = 'round'; context.lineJoin = 'round';
    for (let index = 0; index < trail.points.length; index++) {
      const time = trail.times[index];
      if (time <= cutoff) continue;
      const end = trail.points[index];
      let start = index ? trail.points[index - 1] : end;
      const previousTime = index ? trail.times[index - 1] : time;
      // Clip a segment crossing the expiry boundary, so long slow gestures also shrink.
      if (previousTime < cutoff && time > previousTime) {
        const fraction = (cutoff - previousTime) / (time - previousTime);
        start = start.map((value, axis) => value + (end[axis] - value) * fraction);
      }
      context.globalAlpha = Math.max(0, Math.min(1, (time - cutoff) / 1000));
      context.beginPath();
      if (index === 0) {
        context.arc(end[0] * width, end[1] * height, context.lineWidth / 2, 0, Math.PI * 2);
        context.fill();
      } else {
        context.moveTo(start[0] * width, start[1] * height);
        context.lineTo(end[0] * width, end[1] * height); context.stroke();
      }
    }
    context.globalAlpha = 1;
    return true;
  }
  if (typeof module !== 'undefined') module.exports = { paintTrail };
  else root.SyncShowTeachingTrail = { paintTrail };
})(globalThis);
