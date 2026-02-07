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
      ...options
    };
  }

  /**
   * Calculate the MuPDF scale factor so the rendered image fits
   * the target resolution (contain-style: scale uniformly until
   * the page fits within width×height).
   * @param {Object} pageBounds - {width, height} in PDF points (72pt = 1 inch)
   * @returns {number} scale factor
   */
  _calculateScale(pageBounds) {
    const targetW = this.options.width;
    const targetH = this.options.height;
    const scaleX = targetW / pageBounds.width;
    const scaleY = targetH / pageBounds.height;
    return Math.min(scaleX, scaleY);
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

      // Get the native page size in PDF points and compute scale to fit target
      const bounds = page.getBounds();
      const pageWidth = bounds[2] - bounds[0];
      const pageHeight = bounds[3] - bounds[1];
      const scale = this._calculateScale({ width: pageWidth, height: pageHeight });

      // Render page to a pixmap at the computed scale
      const pixmap = page.toPixmap(
        mupdf.Matrix.scale(scale, scale),
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
