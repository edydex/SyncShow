/**
 * Platform Detector
 *
 * Detects available conversion tools:
 * - Microsoft PowerPoint on Windows (preferred for PPTX -> PDF)
 * - LibreOffice (Windows fallback and macOS/Linux converter)
 */

const LibreOfficeStrategy = require('./strategies/LibreOfficeStrategy');
const PowerPointStrategy = require('./strategies/PowerPointStrategy');

class PlatformDetector {
  /**
   * Detect the best available PPTX converter strategy.
   * On Windows, PowerPoint is preferred over LibreOffice for fidelity.
   * @returns {Promise<BaseStrategy>}
   * @throws {Error} If no converter is found
   */
  static async detectBestStrategy() {
    // On Windows, try PowerPoint first — it produces the most faithful PDFs
    // from PPTX files since it is the native application.
    if (process.platform === 'win32') {
      const powerpoint = await PowerPointStrategy.detect();
      if (powerpoint) {
        return new PowerPointStrategy(powerpoint.path);
      }
    }

    // Fall back to LibreOffice (free, cross-platform)
    const libreoffice = await LibreOfficeStrategy.detect();
    if (libreoffice) {
      return new LibreOfficeStrategy(libreoffice.path, libreoffice.isFlatpak);
    }

    const installHint = process.platform === 'win32'
      ? 'Please install Microsoft PowerPoint or LibreOffice (https://www.libreoffice.org/download/).'
      : 'Please install LibreOffice from https://www.libreoffice.org/download/';

    throw new Error(`No PPTX converter found. ${installHint}`);
  }

  /**
   * Check if all required tools are available
   * @returns {Promise<{available: boolean, missing: string[]}>}
   */
  static async checkRequirements() {
    const missing = [];

    const powerpoint = await PowerPointStrategy.detect();
    const libreoffice = await LibreOfficeStrategy.detect();

    if (!powerpoint && !libreoffice) {
      missing.push('LibreOffice (or Microsoft PowerPoint on Windows)');
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
    const [libreoffice, powerpoint] = await Promise.all([
      LibreOfficeStrategy.detect(),
      PowerPointStrategy.detect()
    ]);

    return {
      platform: process.platform,
      arch: process.arch,
      libreoffice: libreoffice ? libreoffice.path : null,
      libreofficeIsFlatpak: libreoffice ? libreoffice.isFlatpak : false,
      powerpoint: powerpoint ? powerpoint.path : null,
    };
  }
}

module.exports = PlatformDetector;
