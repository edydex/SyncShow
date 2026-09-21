(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SyncShowTeachingPatterns = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const palette = [
    { color:'#ef4444', name:'Red', pattern:'Dots' },
    { color:'#2563eb', name:'Blue', pattern:'Horizontal waves' },
    { color:'#16a34a', name:'Green', pattern:'Vertical waves' },
    { color:'#eab308', name:'Yellow', pattern:'Diagonal lines' },
    { color:'#ffffff', name:'White', pattern:'White' },
    { color:'#111827', name:'Black', pattern:'Black' }
  ];
  function inkAt(index, x, y) {
    x = ((x % 8) + 8) % 8; y = ((y % 8) + 8) % 8;
    if (index === 0) return Math.hypot(x - 3, y - 3) < 1.5;
    if (index === 1) return Math.abs(y - (3 + Math.sin(x * Math.PI / 4) * 1.5)) < 1;
    if (index === 2) return Math.abs(x - (3 + Math.sin(y * Math.PI / 4) * 1.5)) < 1;
    if (index === 3) return (x + y) % 8 < 1.5;
    if (index === 6) return y % 4 < 1;
    if (index === 7) return Math.abs(x - 4) < 1 || Math.abs(y - 4) < 1;
    if (index === 8) return x % 4 < 1;
    return index === 5;
  }
  function family(r, g, b) {
    const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
    if (delta < 30) return -1;
    const hue = (max === r ? (g-b)/delta + (g<b?6:0) : max === g ? (b-r)/delta + 2 : (r-g)/delta + 4) * 60;
    return hue < 15 || hue >= 345 ? 0 : hue < 45 ? 6 : hue < 75 ? 3 : hue < 165 ? 2 : hue < 195 ? 8 : hue < 265 ? 1 : 7;
  }
  // Raster colors (including JPEG antialiasing and photos) are grouped by hue.
  // Neutral text is preserved. A dark boundary keeps thin colored lines readable
  // when a pattern's white gap happens to intersect the whole line.
  function convert(data, width, height, scale = 1) {
    const result = new Uint8ClampedArray(data.length);
    const families = new Int8Array(width * height);
    for (let p = 0; p < families.length; p++) families[p] = family(data[p*4], data[p*4+1], data[p*4+2]);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const p = y * width + x, i = p * 4, color = families[p];
      const edge = color >= 0 && (x === 0 || y === 0 || x === width-1 || y === height-1
        || families[p-1] !== color || families[p+1] !== color || families[p-width] !== color || families[p+width] !== color);
      const value = color < 0 ? Math.round(data[i]*.2126 + data[i+1]*.7152 + data[i+2]*.0722)
        : edge || inkAt(color, x/scale, y/scale) ? 17 : 255;
      result[i] = result[i+1] = result[i+2] = value; result[i+3] = data[i+3];
    }
    return result;
  }
  function tile(color, scale = 1) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = Math.max(8, Math.round(8 * scale));
    const context = canvas.getContext('2d'), data = context.createImageData(canvas.width, canvas.height);
    const index = Math.max(0, palette.findIndex(item => item.color === color));
    for (let y=0;y<canvas.height;y++) for (let x=0;x<canvas.width;x++) {
      const i=(y*canvas.width+x)*4, value=inkAt(index,x/scale,y/scale)?17:255;
      data.data[i]=data.data[i+1]=data.data[i+2]=value;data.data[i+3]=255;
    }
    context.putImageData(data,0,0);return canvas;
  }
  return { palette, inkAt, family, convert, tile };
});
