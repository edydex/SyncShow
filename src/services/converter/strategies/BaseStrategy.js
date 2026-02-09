/**
 * Base Strategy for PPTX to PDF Conversion
 *
 * Abstract base class that defines the interface for converter strategies.
 * Subclasses implement specific conversion methods (LibreOffice, PowerPoint, etc.)
 */

class BaseStrategy {
  /**
   * @param {string} executablePath - Path to the converter executable
   */
  constructor(executablePath) {
    if (new.target === BaseStrategy) {
      throw new Error('BaseStrategy is abstract and cannot be instantiated directly');
    }
    this.executablePath = executablePath;
  }

  /**
   * Convert a PPTX file to PDF
   * @param {string} inputPath - Path to input PPTX file
   * @param {string} outputDir - Directory to save the PDF
   * @returns {Promise<{pdfPath: string}>} Path to generated PDF
   */
  async convertToPdf(inputPath, outputDir) {
    throw new Error('convertToPdf must be implemented by subclass');
  }

  /**
   * Detect if this converter is available on the system
   * @returns {Promise<string|null>} Path to executable if found, null otherwise
   */
  static async detect() {
    throw new Error('detect must be implemented by subclass');
  }

  /**
   * Get the name of this converter strategy
   * @returns {string} Strategy name
   */
  getName() {
    throw new Error('getName must be implemented by subclass');
  }
}

module.exports = BaseStrategy;
