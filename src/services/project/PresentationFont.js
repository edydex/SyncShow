'use strict';
const fs = require('node:fs');
const path = require('node:path');
const FACES = Object.freeze([
  { face: 'Regular', weight: '100 500', style: 'normal', windows: 'arial.ttf', mac: 'Arial.ttf' },
  { face: 'Bold', weight: '600 900', style: 'normal', windows: 'arialbd.ttf', mac: 'Arial Bold.ttf' },
  { face: 'Italic', weight: '100 500', style: 'italic', windows: 'ariali.ttf', mac: 'Arial Italic.ttf' },
  { face: 'BoldItalic', weight: '600 900', style: 'italic', windows: 'arialbi.ttf', mac: 'Arial Bold Italic.ttf' }
]);
function presentationFont({ fontsRoot = path.resolve(__dirname, '../../../assets/fonts').replace(`.asar${path.sep}`, `.asar.unpacked${path.sep}`), platform = process.platform, systemRoot = process.env.WINDIR || 'C:\\Windows', exists = fs.existsSync } = {}) {
  const directories = platform === 'darwin' ? ['/System/Library/Fonts/Supplemental', '/Library/Fonts']
    : platform === 'win32' ? [path.join(systemRoot, 'Fonts')]
    : ['/usr/share/fonts/truetype/msttcorefonts', '/usr/share/fonts/truetype/msttcorefonts/arial'];
  const directory = directories.find(root => FACES.every(face => exists(path.join(root, platform === 'darwin' ? face.mac : face.windows))));
  const faces = FACES.map(face => ({ weight: face.weight, style: face.style,
    path: path.join(directory || fontsRoot, directory ? (platform === 'darwin' ? face.mac : face.windows) : `LiberationSans-${face.face}.ttf`) }));
  return { family: directory ? 'Arial' : 'Liberation Sans', fontPath: faces[0].path, faces };
}
function fontForPath(fontPath) {
  if (!fontPath) return presentationFont();
  if (path.basename(fontPath) === 'NotoSans-Variable.ttf') return { fontPath, family: 'Noto Sans', faces: [{ path: fontPath, weight: '100 900', style: 'normal' }] };
  const arial = /^arial/i.test(path.basename(fontPath));
  const faces = FACES.map(face => ({weight:face.weight, style:face.style, path:path.join(path.dirname(fontPath), arial ? (process.platform === 'darwin' ? face.mac : face.windows) : `LiberationSans-${face.face}.ttf`)}));
  return {fontPath, family:arial ? 'Arial' : 'Liberation Sans', faces};
}
module.exports = { presentationFont, fontForPath };
