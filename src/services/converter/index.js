/**
 * SyncShow Converter Module
 *
 * Converts PPTX presentations to JPEG images using LibreOffice and MuPDF.
 */

const Converter = require('./Converter');
const PlatformDetector = require('./PlatformDetector');

/**
 * Convenience function for one-off conversions
 * @param {string} inputPath - Path to PPTX file
 * @param {string} outputDir - Output directory for images
 * @param {Object} options - Conversion options
 * @returns {Promise<Object>} Conversion result
 */
async function convert(inputPath, outputDir, options = {}) {
  const converter = new Converter(options);
  return converter.convert(inputPath, outputDir);
}

module.exports = {
  Converter,
  PlatformDetector,
  convert
};
