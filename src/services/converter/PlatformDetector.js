/**
 * Platform Detector
 *
 * Detects available conversion tools:
 * - LibreOffice (required for PPTX → PDF)
 */

const LibreOfficeStrategy = require('./strategies/LibreOfficeStrategy');

class PlatformDetector {
  /**
   * Detect the best available PPTX converter strategy
   * @returns {Promise<LibreOfficeStrategy>}
   * @throws {Error} If no converter is found
   */
  static async detectBestStrategy() {
    // Try LibreOffice first (free, cross-platform)
    const libreoffice = await LibreOfficeStrategy.detect();
    if (libreoffice) {
      return new LibreOfficeStrategy(libreoffice.path, libreoffice.isFlatpak);
    }

    // Future: Try PowerPoint here

    throw new Error(
      'No PPTX converter found. Please install LibreOffice from https://www.libreoffice.org/download/'
    );
  }

  /**
   * Check if all required tools are available
   * @returns {Promise<{available: boolean, missing: string[]}>}
   */
  static async checkRequirements() {
    const missing = [];

    const libreoffice = await LibreOfficeStrategy.detect();
    if (!libreoffice) {
      missing.push('LibreOffice');
    }

    return {
      available: missing.length === 0,
      missing
    };
  }

  /**
   * Get diagnostic information about detected tools
   * @returns {Promise<Object>}
   */
  static async getDiagnostics() {
    const libreoffice = await LibreOfficeStrategy.detect();

    return {
      platform: process.platform,
      arch: process.arch,
      libreoffice: libreoffice ? libreoffice.path : null,
      libreofficeIsFlatpak: libreoffice ? libreoffice.isFlatpak : false,
    };
  }
}

module.exports = PlatformDetector;
