/**
 * PDF to Image Converter
 *
 * Converts PDF pages to JPEG images using bundled Ghostscript and sharp.
 * Uses Ghostscript directly for PDF rendering, then sharp for resizing/formatting.
 */

const { EventEmitter } = require('events');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs').promises;
const sharp = require('sharp');
const PlatformDetector = require('./PlatformDetector');

class PdfToImageConverter extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = {
      width: options.width || 1920,
      height: options.height || 1080,
      quality: options.quality || 92,
      density: options.density || 150, // DPI for PDF rendering
      ...options
    };
  }

  /**
   * Get the number of pages in a PDF
   * @param {string} pdfPath - Path to PDF file
   * @param {string} gsPath - Path to Ghostscript executable
   * @returns {Promise<number>}
   */
  async getPageCount(pdfPath, gsPath) {
    return new Promise((resolve, reject) => {
      const args = [
        '-q',
        '-dNODISPLAY',
        '-c',
        `(${pdfPath.replace(/\\/g, '/')}) (r) file runpdfbegin pdfpagecount = quit`
      ];

      execFile(gsPath, args, { encoding: 'utf8' }, (error, stdout, stderr) => {
        if (error) {
          // Fallback: try using pdfinfo-like approach or estimate
          reject(error);
          return;
        }
        const count = parseInt(stdout.trim(), 10);
        resolve(isNaN(count) ? 1 : count);
      });
    });
  }

  /**
   * Convert a PDF file to JPEG images
   * @param {string} pdfPath - Path to input PDF
   * @param {string} outputDir - Directory to save images
   * @returns {Promise<{slideCount: number}>}
   */
  async convert(pdfPath, outputDir) {
    const gsPath = await PlatformDetector.getGhostscriptPath();
    if (!gsPath) {
      throw new Error('Ghostscript not found. Run npm run setup-deps to install bundled dependencies.');
    }

    // Create temp directory for PNG output
    const tempDir = path.join(outputDir, '_temp_png');
    await fs.mkdir(tempDir, { recursive: true });

    // Set up environment for Ghostscript
    const gsLibPath = PlatformDetector.getGhostscriptLibPath();
    const env = { ...process.env };

    if (process.platform === 'win32') {
      // Windows: set GS_LIB
      env.GS_LIB = gsLibPath;
    } else {
      // Unix: add lib path
      env.GS_LIB = gsLibPath;
    }

    // Render PDF pages to PNG using Ghostscript
    const gsArgs = [
      '-dNOPAUSE',
      '-dBATCH',
      '-dSAFER',
      '-sDEVICE=png16m',
      `-r${this.options.density}`,
      '-dTextAlphaBits=4',
      '-dGraphicsAlphaBits=4',
      `-sOutputFile=${path.join(tempDir, 'page_%03d.png')}`,
      pdfPath
    ];

    await new Promise((resolve, reject) => {
      execFile(gsPath, gsArgs, { env, maxBuffer: 50 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`Ghostscript failed: ${stderr || error.message}`));
          return;
        }
        resolve();
      });
    });

    // Get list of generated PNG files
    const pngFiles = (await fs.readdir(tempDir))
      .filter(f => f.startsWith('page_') && f.endsWith('.png'))
      .sort();

    const slideCount = pngFiles.length;

    // Convert each PNG to JPEG with proper sizing
    for (let i = 0; i < pngFiles.length; i++) {
      const pngPath = path.join(tempDir, pngFiles[i]);
      const slideNum = String(i + 1).padStart(3, '0');
      const jpgPath = path.join(outputDir, `slide_${slideNum}.jpg`);

      // Resize and convert to JPEG with letterboxing
      await sharp(pngPath)
        .resize(this.options.width, this.options.height, {
          fit: 'contain',
          background: { r: 0, g: 0, b: 0 }
        })
        .jpeg({ quality: this.options.quality })
        .toFile(jpgPath);

      // Emit progress
      const percent = Math.round(((i + 1) / slideCount) * 100);
      this.emit('progress', { percent, current: i + 1, total: slideCount });

      // Remove temp PNG
      await fs.unlink(pngPath);
    }

    // Remove temp directory
    try {
      await fs.rmdir(tempDir);
    } catch (e) {
      // Ignore cleanup errors
    }

    return { slideCount };
  }
}

module.exports = PdfToImageConverter;
