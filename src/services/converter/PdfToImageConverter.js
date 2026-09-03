/**
 * PDF to Image Converter
 *
 * Converts PDF pages to JPEG images using PDF.js, @napi-rs/canvas,
 * and sharp. The shared PDF engine renders each page to a bounded PNG;
 * sharp applies the existing black-edge treatment and JPEG encoding.
 */

const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs').promises;
const sharp = require('sharp');
const {
  PDF_RENDERER_PROVENANCE,
  openPdf
} = require('../pdf/PdfEngine');

async function writeFlattenedJpeg(png, outputPath, quality) {
  await sharp(png)
    .flatten({ background: { r: 0, g: 0, b: 0 } })
    .jpeg({ quality })
    .toFile(outputPath);
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
   * Convert a PDF file to JPEG images
   * @param {string} pdfPath - Path to input PDF
   * @param {string} outputDir - Directory to save images
   * @returns {Promise<{slideCount: number, pdfRenderer: Object}>}
   */
  async convert(pdfPath, outputDir) {
    const data = await fs.readFile(pdfPath);
    const document = await openPdf(data);
    const slideCount = document.pageCount;
    let conversionError = null;

    try {
      for (let i = 0; i < slideCount; i++) {
        const rendered = await document.renderPageToPng(i, {
          maximumWidth: this.options.width,
          maximumHeight: this.options.height
        });

        // flatten() replaces transparent edge pixels from sub-pixel rounding
        // with black. The display browser still uses object-fit:contain.
        const slideNum = String(i + 1).padStart(3, '0');
        const jpgPath = path.join(outputDir, `slide_${slideNum}.jpg`);

        await writeFlattenedJpeg(rendered.png, jpgPath, this.options.quality);

        const percent = Math.round(((i + 1) / slideCount) * 100);
        this.emit('progress', { percent, current: i + 1, total: slideCount });
      }

      return {
        slideCount,
        pdfRenderer: { ...PDF_RENDERER_PROVENANCE }
      };
    } catch (error) {
      conversionError = error;
      throw error;
    } finally {
      try {
        await document.close();
      } catch (error) {
        if (!conversionError) throw error;
        conversionError.cleanupError = error;
      }
    }
  }
}

module.exports = PdfToImageConverter;
module.exports.writeFlattenedJpeg = writeFlattenedJpeg;
