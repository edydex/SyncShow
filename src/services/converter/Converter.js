/**
 * Main Converter Orchestrator
 *
 * Coordinates the full conversion pipeline:
 * 1. PPTX -> PDF (via PowerPoint or LibreOffice)
 * 2. PDF -> JPEG (via MuPDF + sharp)
 * 3. Thumbnail generation (via sharp)
 * 4. Text extraction (via pptxtojson)
 * 5. Metadata generation
 * 6. Validated, transactional publication of the new cache generation
 */

const { EventEmitter } = require('events');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs').promises;

const PlatformDetector = require('./PlatformDetector');
const LibreOfficeStrategy = require('./strategies/LibreOfficeStrategy');
const PdfToImageConverter = require('./PdfToImageConverter');
const ThumbnailGenerator = require('./ThumbnailGenerator');
const TextExtractor = require('./TextExtractor');
const { normalizeCacheRestoreContext } = require('../show/CacheRestoreResolver');

// Converter instances are short-lived, but multiple instances can still target
// the same language cache. Serialize only the final directory swap; the costly
// rendering work can continue in parallel in isolated staging directories.
const publicationQueues = new Map();

async function withPublicationLock(outputDir, operation) {
  const key = path.resolve(outputDir);
  const previous = publicationQueues.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);

  publicationQueues.set(key, current);

  try {
    return await current;
  } finally {
    if (publicationQueues.get(key) === current) {
      publicationQueues.delete(key);
    }
  }
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

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
   * Initialize the converter by detecting available tools.
   */
  async initialize() {
    if (!this.strategy) {
      this.strategy = await PlatformDetector.detectBestStrategy();
    }
    return this;
  }

  /**
   * Convert with the selected strategy. If native PowerPoint fails on Windows,
   * make one isolated LibreOffice attempt when LibreOffice is installed.
   */
  async _convertToPdf(inputPath, stagingDir) {
    try {
      return await this.strategy.convertToPdf(inputPath, stagingDir);
    } catch (powerPointError) {
      if (this.strategy.getName() !== 'PowerPoint') {
        throw powerPointError;
      }

      const detectedLibreOffice = await LibreOfficeStrategy.detect();
      if (!detectedLibreOffice) {
        throw powerPointError;
      }

      console.warn(
        `[Converter] PowerPoint conversion failed; retrying with LibreOffice: ${powerPointError.message}`
      );
      this.emit('progress', {
        percent: 5,
        stage: 'converting-to-pdf',
        converter: 'LibreOffice',
        fallbackFrom: 'PowerPoint',
        message: powerPointError.message
      });

      const fallback = new LibreOfficeStrategy(
        detectedLibreOffice.path,
        detectedLibreOffice.isFlatpak
      );

      try {
        return await fallback.convertToPdf(inputPath, stagingDir);
      } catch (libreOfficeError) {
        const error = new Error(
          'PPTX to PDF conversion failed with both PowerPoint and LibreOffice. ' +
          `PowerPoint: ${powerPointError.message} LibreOffice: ${libreOfficeError.message}`
        );
        error.cause = libreOfficeError;
        error.powerPointError = powerPointError;
        throw error;
      }
    }
  }

  /**
   * Remove a strategy's temporary PDF artifacts after rendering finishes.
   */
  async _cleanupPdfResult(pdfResult) {
    if (!pdfResult) return;

    if (typeof pdfResult.cleanup === 'function') {
      await pdfResult.cleanup();
      return;
    }

    if (pdfResult.pdfPath) {
      await fs.unlink(pdfResult.pdfPath).catch(error => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  }

  /**
   * Normalize extracted text so metadata always has one entry per rendered
   * slide, even when pptxtojson cannot read a particular presentation.
   */
  _normalizeSlides(slides, slideCount) {
    const extracted = Array.isArray(slides) ? slides : [];

    return Array.from({ length: slideCount }, (_, index) => {
      const slide = extracted[index] || {};
      return {
        text: typeof slide.text === 'string' ? slide.text : '',
        firstLine: typeof slide.firstLine === 'string' ? slide.firstLine : ''
      };
    });
  }

  /**
   * Validate a complete cache generation before it can become active.
   * Every expected full-size slide and thumbnail must be present, non-empty,
   * and numbered contiguously, and metadata must agree with the artifacts.
   */
  async _validateGeneration(generationDir, expectedSlideCount = null) {
    const metadataPath = path.join(generationDir, 'metadata.json');
    let metadata;

    try {
      metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
    } catch (error) {
      throw new Error(`Invalid conversion metadata in ${generationDir}: ${error.message}`);
    }

    const slideCount = expectedSlideCount === null
      ? metadata.slideCount
      : expectedSlideCount;

    if (!Number.isSafeInteger(slideCount) || slideCount < 1) {
      throw new Error(`Invalid slide count in ${generationDir}: ${slideCount}`);
    }

    if (metadata.slideCount !== slideCount) {
      throw new Error(
        `Metadata slide count ${metadata.slideCount} does not match rendered slide count ${slideCount}`
      );
    }

    if (!Array.isArray(metadata.slides) || metadata.slides.length !== slideCount) {
      const actualCount = Array.isArray(metadata.slides) ? metadata.slides.length : 'invalid';
      throw new Error(
        `Metadata contains ${actualCount} slide entries; expected ${slideCount}`
      );
    }

    // Provenance is optional for caches created by older SyncShow versions,
    // but once present it is part of the validated generation contract.
    normalizeCacheRestoreContext(metadata.restoreContext);

    const files = await fs.readdir(generationDir);
    const actualSlides = files
      .filter(file => /^slide_\d+\.jpg$/.test(file))
      .sort();
    const actualThumbnails = files
      .filter(file => /^slide_\d+_thumb\.jpg$/.test(file))
      .sort();
    const expectedSlides = [];
    const expectedThumbnails = [];

    for (let index = 1; index <= slideCount; index++) {
      const number = String(index).padStart(3, '0');
      expectedSlides.push(`slide_${number}.jpg`);
      expectedThumbnails.push(`slide_${number}_thumb.jpg`);
    }

    const expectedSlideSet = new Set(expectedSlides);
    const expectedThumbnailSet = new Set(expectedThumbnails);

    if (actualSlides.length !== expectedSlides.length ||
        actualSlides.some(file => !expectedSlideSet.has(file))) {
      throw new Error(
        `Slide images in ${generationDir} are missing, extra, or not contiguously numbered`
      );
    }

    if (actualThumbnails.length !== expectedThumbnails.length ||
        actualThumbnails.some(file => !expectedThumbnailSet.has(file))) {
      throw new Error(
        `Slide thumbnails in ${generationDir} are missing, extra, or not contiguously numbered`
      );
    }

    const expectedFiles = new Set([
      'metadata.json',
      ...expectedSlides,
      ...expectedThumbnails
    ]);
    const unexpectedFiles = files.filter(file => !expectedFiles.has(file));
    if (unexpectedFiles.length > 0) {
      throw new Error(
        `Unexpected artifacts in ${generationDir}: ${unexpectedFiles.join(', ')}`
      );
    }

    await Promise.all(
      [...expectedSlides, ...expectedThumbnails].map(async file => {
        const stats = await fs.stat(path.join(generationDir, file));
        if (!stats.isFile() || stats.size < 1) {
          throw new Error(`Conversion artifact is empty or not a file: ${file}`);
        }
      })
    );

    return metadata;
  }

  async validateGeneration(generationDir, expectedSlideCount = null) {
    return this._validateGeneration(generationDir, expectedSlideCount);
  }

  /**
   * Keep the immediately previous valid cache generation at a stable sibling
   * path without sacrificing an older last-good generation if bookkeeping
   * itself fails.
   */
  async _preserveLastGood(rollbackDir, lastGoodDir) {
    const displacedLastGood = `${lastGoodDir}.old-${crypto.randomUUID()}`;
    let displaced = false;

    try {
      await fs.rename(lastGoodDir, displacedLastGood);
      displaced = true;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn(
          `[Converter] Could not prepare ${lastGoodDir}; retained rollback at ${rollbackDir}: ${error.message}`
        );
        return;
      }
    }

    try {
      await fs.rename(rollbackDir, lastGoodDir);
    } catch (error) {
      // Restore the older stable last-good path if the new backup could not be
      // installed. The unique rollback directory is intentionally retained.
      if (displaced) {
        await fs.rename(displacedLastGood, lastGoodDir).catch(restoreError => {
          console.warn(
            `[Converter] Could not restore prior last-good cache ${displacedLastGood}: ${restoreError.message}`
          );
        });
      }
      console.warn(
        `[Converter] Could not update ${lastGoodDir}; retained rollback at ${rollbackDir}: ${error.message}`
      );
      return;
    }

    if (displaced) {
      await fs.rm(displacedLastGood, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100
      }).catch(error => {
        console.warn(
          `[Converter] Could not remove older last-good cache ${displacedLastGood}: ${error.message}`
        );
      });
    }
  }

  /**
   * Publish a validated staging directory. If installing the new generation
   * fails after moving the active cache aside, restore the active cache before
   * propagating the error.
   */
  async _replaceActiveGeneration(stagingDir, outputDir) {
    const activeDir = path.resolve(outputDir);

    return withPublicationLock(activeDir, async () => {
      const lastGoodDir = `${activeDir}.last-good`;
      const rollbackDir = `${activeDir}.rollback-${crypto.randomUUID()}`;
      let movedActive = false;

      if (await pathExists(activeDir)) {
        await fs.rename(activeDir, rollbackDir);
        movedActive = true;
      }

      try {
        // Both paths share a parent directory, so this is a same-filesystem
        // atomic rename. No partially rendered files are ever published.
        await fs.rename(stagingDir, activeDir);
      } catch (replacementError) {
        if (movedActive) {
          try {
            await fs.rename(rollbackDir, activeDir);
          } catch (restoreError) {
            replacementError.message +=
              ` Active cache rollback also failed: ${restoreError.message}. ` +
              `The previous generation remains at ${rollbackDir}.`;
            replacementError.rollbackError = restoreError;
          }
        }
        throw replacementError;
      }

      if (movedActive) {
        try {
          await this._validateGeneration(rollbackDir);
          await this._preserveLastGood(rollbackDir, lastGoodDir);
        } catch (error) {
          // Main currently creates an empty language directory before the first
          // conversion. Remove only that conclusively empty placeholder. A
          // non-empty generation is retained at its unique rollback path even
          // if validation fails (including transient EACCES/EMFILE failures).
          let previousFiles = null;
          try {
            previousFiles = await fs.readdir(rollbackDir);
          } catch (readError) {
            console.warn(
              `[Converter] Could not inspect previous cache ${rollbackDir}; retained it: ${readError.message}`
            );
          }

          if (previousFiles && previousFiles.length === 0) {
            await fs.rm(rollbackDir, {
              recursive: true,
              force: true,
              maxRetries: 3,
              retryDelay: 100
            }).catch(cleanupError => {
              console.warn(
                `[Converter] Could not remove empty previous cache ${rollbackDir}: ${cleanupError.message}`
              );
            });
          } else if (previousFiles) {
            console.warn(
              `[Converter] Previous cache did not pass last-good validation; ` +
              `retained it at ${rollbackDir}: ${error.message}`
            );
          }
        }
      }
    });
  }

  /**
   * Convert a PPTX file to slide images.
   * @param {string} inputPath - Path to PPTX file
   * @param {string} outputDir - Active output directory
   * @param {Object|null} restoreContext - Validated one-click restore grouping
   * @returns {Promise<Object>} Conversion result
   */
  async convert(inputPath, outputDir, restoreContext = null) {
    const activeDir = path.resolve(outputDir);
    const normalizedRestoreContext = normalizeCacheRestoreContext(restoreContext);
    await fs.mkdir(path.dirname(activeDir), { recursive: true });

    // A sibling directory guarantees the final rename stays on one filesystem.
    const stagingDir = await fs.mkdtemp(`${activeDir}.staging-`);
    let pdfResult = null;
    let slideCount;
    let metadata;

    try {
      await this.initialize();

      this.emit('progress', { percent: 0, stage: 'starting' });

      // Step 1: Convert PPTX to PDF
      this.emit('progress', { percent: 5, stage: 'converting-to-pdf' });
      pdfResult = await this._convertToPdf(inputPath, stagingDir);

      // Step 2: Convert PDF to JPEGs
      this.emit('progress', { percent: 20, stage: 'rendering-slides' });
      const pdfConverter = new PdfToImageConverter(this.options);
      pdfConverter.on('progress', (progress) => {
        // Map 0-100 to 20-70
        const mappedPercent = 20 + (progress.percent * 0.5);
        this.emit('progress', { percent: mappedPercent, stage: 'rendering-slides' });
      });
      ({ slideCount } = await pdfConverter.convert(pdfResult.pdfPath, stagingDir));

      // The PDF is not part of a cache generation. Remove it before validation
      // and publication, including LibreOffice's temporary output directory.
      await this._cleanupPdfResult(pdfResult);
      pdfResult = null;

      // Step 3: Generate thumbnails
      this.emit('progress', { percent: 70, stage: 'generating-thumbnails' });
      const thumbGenerator = new ThumbnailGenerator(this.options);
      await thumbGenerator.generateAll(stagingDir);

      // Step 4: Extract text from PPTX
      this.emit('progress', { percent: 85, stage: 'extracting-text' });
      const textExtractor = new TextExtractor();
      const extractedSlides = await textExtractor.extract(inputPath);
      const slides = this._normalizeSlides(extractedSlides, slideCount);

      // Step 5: Write metadata
      this.emit('progress', { percent: 95, stage: 'writing-metadata' });
      metadata = {
        sourceFile: path.basename(inputPath),
        originalFile: inputPath,
        slideCount,
        generatedAt: new Date().toISOString(),
        convertedAt: new Date().toISOString(),
        restoreContext: normalizedRestoreContext,
        slides
      };
      await fs.writeFile(
        path.join(stagingDir, 'metadata.json'),
        JSON.stringify(metadata, null, 2)
      );

      // Step 6: Validate and publish the complete generation
      this.emit('progress', { percent: 97, stage: 'validating-output' });
      metadata = await this._validateGeneration(stagingDir, slideCount);
      this.emit('progress', { percent: 99, stage: 'publishing-output' });
      await this._replaceActiveGeneration(stagingDir, activeDir);

      this.emit('progress', { percent: 100, stage: 'complete' });

      return {
        success: true,
        slideCount,
        outputDir,
        metadata
      };
    } finally {
      // These are no-ops after successful cleanup/publication. On any failure,
      // no staging artifacts or strategy-owned PDF directories are leaked.
      if (pdfResult) {
        await this._cleanupPdfResult(pdfResult).catch(error => {
          console.warn(`[Converter] Could not clean temporary PDF: ${error.message}`);
        });
      }
      await fs.rm(stagingDir, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100
      }).catch(error => {
        console.warn(`[Converter] Could not clean staging directory ${stagingDir}: ${error.message}`);
      });
    }
  }
}

module.exports = Converter;
