/**
 * PDF to Image Converter
 *
 * Converts PDF pages to JPEG images using MuPDF (WASM) and sharp.
 * MuPDF renders PDF pages to pixel buffers directly, then sharp
 * resizes and converts to JPEG.
 */

const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs').promises;
const sharp = require('sharp');

// mupdf is ESM-only; cache the dynamic import
let _mupdf = null;
async function getMupdf() {
  if (!_mupdf) {
    _mupdf = await import('mupdf');
  }
  return _mupdf;
}

class PdfToImageConverter extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = {
      width: options.width || 1920,
      height: options.height || 1080,
      quality: options.quality || 92,
      scale: options.scale || 2.0, // Render scale for PDF pages
      ...options
    };
  }

  /**
   * Convert a PDF file to JPEG images
   * @param {string} pdfPath - Path to input PDF
   * @param {string} outputDir - Directory to save images
   * @returns {Promise<{slideCount: number}>}
   */
  async convert(pdfPath, outputDir) {
    const mupdf = await getMupdf();

    const data = await fs.readFile(pdfPath);
    const doc = mupdf.Document.openDocument(data, 'application/pdf');
    const slideCount = doc.countPages();

    for (let i = 0; i < slideCount; i++) {
      const page = doc.loadPage(i);

      // Render page to a pixmap at the configured scale
      const pixmap = page.toPixmap(
        mupdf.Matrix.scale(this.options.scale, this.options.scale),
        mupdf.ColorSpace.DeviceRGB,
        true,  // alpha — unrendered edge pixels become transparent instead of white
        true   // include annotations
      );

      const pngBuffer = pixmap.asPNG();

      // Convert to JPEG. flatten() replaces any transparent edge pixels
      // (from sub-pixel rounding) with black. No resize/letterboxing needed —
      // the display browser uses object-fit:contain to adapt to any screen.
      const slideNum = String(i + 1).padStart(3, '0');
      const jpgPath = path.join(outputDir, `slide_${slideNum}.jpg`);

      await sharp(Buffer.from(pngBuffer))
        .flatten({ background: { r: 0, g: 0, b: 0 } })
        .jpeg({ quality: this.options.quality })
        .toFile(jpgPath);

      // Emit progress
      const percent = Math.round(((i + 1) / slideCount) * 100);
      this.emit('progress', { percent, current: i + 1, total: slideCount });
    }

    return { slideCount };
  }
}

module.exports = PdfToImageConverter;
