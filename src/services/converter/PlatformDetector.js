/**
 * Platform Detector
 *
 * Detects available conversion tools:
 * - LibreOffice (required for PPTX → PDF)
 * - Bundled ImageMagick (for PDF → JPEG)
 * - Bundled Ghostscript (for PDF processing)
 */

const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');

const LibreOfficeStrategy = require('./strategies/LibreOfficeStrategy');

// Lazy-load electron app to avoid issues when module loads before app is ready
let _app = null;
function getApp() {
  if (!_app) {
    try {
      _app = require('electron').app;
    } catch (e) {
      _app = null;
    }
  }
  return _app;
}

// Determine if running in packaged app
function isPackaged() {
  const app = getApp();
  return app ? app.isPackaged : false;
}

class PlatformDetector {
  /**
   * Get the path to bundled tools
   * @param {string} tool - Tool name ('imagemagick' or 'ghostscript')
   * @returns {string} Path to tool directory
   */
  static getBundledPath(tool) {
    const platform = process.platform;
    const arch = process.arch;
    const platformDir = `${platform}-${arch}`;

    if (isPackaged()) {
      return path.join(process.resourcesPath, `${tool}-embed`, platformDir);
    } else {
      // Development: look in project root
      return path.join(__dirname, '..', '..', '..', '..', `${tool}-embed`, platformDir);
    }
  }

  /**
   * Get the path to bundled ImageMagick executable
   * @returns {Promise<string|null>} Path to magick executable
   */
  static async getImageMagickPath() {
    const bundledPath = PlatformDetector.getBundledPath('imagemagick');
    const exeName = process.platform === 'win32' ? 'magick.exe' : 'magick';
    const fullPath = path.join(bundledPath, exeName);

    try {
      await fs.access(fullPath, fsSync.constants.X_OK);
      return fullPath;
    } catch (e) {
      return null;
    }
  }

  /**
   * Get the path to bundled Ghostscript executable
   * @returns {Promise<string|null>} Path to gs executable
   */
  static async getGhostscriptPath() {
    const bundledPath = PlatformDetector.getBundledPath('ghostscript');
    let exeName;

    if (process.platform === 'win32') {
      exeName = path.join('bin', 'gswin64c.exe');
    } else {
      exeName = path.join('bin', 'gs');
    }

    const fullPath = path.join(bundledPath, exeName);

    try {
      await fs.access(fullPath, fsSync.constants.X_OK);
      return fullPath;
    } catch (e) {
      return null;
    }
  }

  /**
   * Get the path to Ghostscript library directory
   * @returns {string} Path to gs lib directory
   */
  static getGhostscriptLibPath() {
    const bundledPath = PlatformDetector.getBundledPath('ghostscript');
    return path.join(bundledPath, 'lib');
  }

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

    // Check LibreOffice
    const libreoffice = await LibreOfficeStrategy.detect();
    if (!libreoffice) {
      missing.push('LibreOffice');
    }

    // Check ImageMagick
    const imageMagick = await PlatformDetector.getImageMagickPath();
    if (!imageMagick) {
      missing.push('ImageMagick (bundled)');
    }

    // Check Ghostscript
    const ghostscript = await PlatformDetector.getGhostscriptPath();
    if (!ghostscript) {
      missing.push('Ghostscript (bundled)');
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
    const imageMagick = await PlatformDetector.getImageMagickPath();
    const ghostscript = await PlatformDetector.getGhostscriptPath();

    return {
      platform: process.platform,
      arch: process.arch,
      isPackaged: isPackaged(),
      libreoffice: libreoffice ? libreoffice.path : null,
      libreofficeIsFlatpak: libreoffice ? libreoffice.isFlatpak : false,
      imageMagick,
      ghostscript,
      ghostscriptLib: PlatformDetector.getGhostscriptLibPath()
    };
  }
}

module.exports = PlatformDetector;
