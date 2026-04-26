/**
 * Main Converter Orchestrator
 *
 * Coordinates the full conversion pipeline:
 * 1. PPTX → PDF (via LibreOffice)
 * 2. PDF → JPEG (via MuPDF + sharp)
 * 3. Thumbnail generation (via sharp)
 * 4. Text extraction (via pptxtojson)
 * 5. Metadata generation
 */

const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs').promises;

const PlatformDetector = require('./PlatformDetector');
const LibreOfficeStrategy = require('./strategies/LibreOfficeStrategy');
const PdfToImageConverter = require('./PdfToImageConverter');
const ThumbnailGenerator = require('./ThumbnailGenerator');
const TextExtractor = require('./TextExtractor');

class Converter extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = {
      width: options.width || 1920,
      height: options.height || 1080,
      thumbnailWidth: options.thumbnailWidth || 300,
      quality: options.quality || 92,
      thumbnailQuality: options.thumbnailQuality || 85,
      ...options
    };
    this.strategy = null;
  }

  /**
   * Initialize the converter by detecting available tools
   */
  async initialize() {
    if (!this.strategy) {
      this.strategy = await PlatformDetector.detectBestStrategy();
    }
    return this;
  }

  /**
   * Remove stale slide images and metadata from a previous conversion.
   * Called before starting a new conversion so leftover files from a
   * larger previous presentation never appear in the grid.
   * @param {string} outputDir
   */
  async _cleanOutputDir(outputDir) {
    try {
      const files = await fs.readdir(outputDir);
      const toDelete = files.filter(f =>
        (f.startsWith('slide_') && f.endsWith('.jpg')) || f === 'metadata.json'
      );
      await Promise.all(toDelete.map(f => fs.unlink(path.join(outputDir, f)).catch(() => {})));
      if (toDelete.length > 0) {
        console.log(`[Converter] Cleaned ${toDelete.length} stale file(s) from ${outputDir}`);
      }
    } catch (e) {
      // Directory doesn't exist yet — nothing to clean
    }
  }

  /**
   * Convert a PPTX file to slide images
   * @param {string} inputPath - Path to PPTX file
   * @param {string} outputDir - Output directory
   * @returns {Promise<Object>} Conversion result
   */
  async convert(inputPath, outputDir) {
    // Ensure output directory exists
    await fs.mkdir(outputDir, { recursive: true });

    // Remove stale files from any previous conversion before writing new ones.
    // Without this, loading a shorter presentation leaves orphaned slide_NNN.jpg
    // files that show up in the grid.
    await this._cleanOutputDir(outputDir);

    // Initialize if not already done
    await this.initialize();

    this.emit('progress', { percent: 0, stage: 'starting' });

    // Step 1: Convert PPTX to PDF
    this.emit('progress', { percent: 5, stage: 'converting-to-pdf' });
    const { pdfPath } = await this.strategy.convertToPdf(inputPath, outputDir);

    // Step 2: Convert PDF to JPEGs
    this.emit('progress', { percent: 20, stage: 'rendering-slides' });
    const pdfConverter = new PdfToImageConverter(this.options);
    pdfConverter.on('progress', (p) => {
      // Map 0-100 to 20-70
      const mappedPercent = 20 + (p.percent * 0.5);
      this.emit('progress', { percent: mappedPercent, stage: 'rendering-slides' });
    });
    const { slideCount } = await pdfConverter.convert(pdfPath, outputDir);

    // Step 3: Generate thumbnails
    this.emit('progress', { percent: 70, stage: 'generating-thumbnails' });
    const thumbGenerator = new ThumbnailGenerator(this.options);
    await thumbGenerator.generateAll(outputDir);

    // Step 4: Extract text from PPTX
    this.emit('progress', { percent: 85, stage: 'extracting-text' });
    const textExtractor = new TextExtractor();
    const slides = await textExtractor.extract(inputPath);

    // Step 5: Write metadata
    this.emit('progress', { percent: 95, stage: 'writing-metadata' });
    const metadata = {
      sourceFile: path.basename(inputPath),
      originalFile: inputPath,
      slideCount,
      generatedAt: new Date().toISOString(),
      convertedAt: new Date().toISOString(),
      slides
    };
    await fs.writeFile(
      path.join(outputDir, 'metadata.json'),
      JSON.stringify(metadata, null, 2)
    );

    // Step 6: Cleanup temp PDF
    try {
      await fs.unlink(pdfPath);
    } catch (e) {
      // Ignore cleanup errors
    }

    this.emit('progress', { percent: 100, stage: 'complete' });

    return {
      success: true,
      slideCount,
      outputDir,
      metadata
    };
  }
}

module.exports = Converter;
