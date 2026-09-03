/**
 * SyncShow Converter Module
 *
 * Converts PPTX presentations to JPEG images using PowerPoint/LibreOffice,
 * the shared PDF.js engine, native canvas, and sharp.
 */

const Converter = require('./Converter');
const PlatformDetector = require('./PlatformDetector');
const {
  serializeConversionFailure
} = require('./ConversionFailure');

/**
 * Convenience function for one-off conversions
 * @param {string} inputPath - Path to PPTX file
 * @param {string} outputDir - Output directory for images
 * @param {Object} options - Conversion options
 * @returns {Promise<Object>} Conversion result
 */
async function convert(inputPath, outputDir, options = {}, restoreContext = null) {
  const converter = new Converter(options);
  return converter.convert(inputPath, outputDir, restoreContext);
}

module.exports = {
  Converter,
  PlatformDetector,
  convert,
  serializeConversionFailure
};
