/* Rotate the complete demo surface, including captions and annotations. The
 * logical viewport stays landscape; ordinary projection windows are unchanged. */
(() => {
  'use strict';
  const requested = Number(new URLSearchParams(location.search).get('testOutputRotation') || 0);
  const rotation = [90, 270].includes(requested) ? requested : 0;
  function resize() {
    const width = rotation ? innerHeight : innerWidth;
    const height = rotation ? innerWidth : innerHeight;
    document.documentElement.style.setProperty('--output-vw', `${width / 100}px`);
    document.documentElement.style.setProperty('--output-vh', `${height / 100}px`);
    if (!rotation) return;
    Object.assign(document.body.style, {
      position: 'absolute', left: '0', top: '0', width: `${width}px`, height: `${height}px`,
      transformOrigin: '0 0',
      transform: rotation === 90 ? `translateX(${height}px) rotate(90deg)` : `translateY(${width}px) rotate(270deg)`
    });
    document.body.dataset.testOutputRotation = String(rotation);
  }
  resize();
  addEventListener('resize', resize);
})();
