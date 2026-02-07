/**
 * LibreOffice Strategy for PPTX to PDF Conversion
 *
 * Uses LibreOffice in headless mode to convert PPTX to PDF.
 * Supports standard installations, snap, and flatpak on Linux.
 */

const { spawn, execFile } = require('child_process');
const path = require('path');
const fs = require('fs').promises;
const os = require('os');
const BaseStrategy = require('./BaseStrategy');

class LibreOfficeStrategy extends BaseStrategy {
  // Search paths for LibreOffice by platform
  static SEARCH_PATHS = {
    win32: [
      'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
      'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'LibreOffice', 'program', 'soffice.exe')
    ],
    darwin: [
      '/Applications/LibreOffice.app/Contents/MacOS/soffice',
      path.join(os.homedir(), 'Applications', 'LibreOffice.app', 'Contents', 'MacOS', 'soffice')
    ],
    linux: [
      '/usr/bin/soffice',
      '/usr/bin/libreoffice',
      '/usr/local/bin/soffice',
      '/snap/bin/libreoffice',
      '/var/lib/flatpak/exports/bin/org.libreoffice.LibreOffice',
      path.join(os.homedir(), '.local', 'share', 'flatpak', 'exports', 'bin', 'org.libreoffice.LibreOffice')
    ]
  };

  constructor(executablePath, isFlatpak = false) {
    super(executablePath);
    this.isFlatpak = isFlatpak;
  }

  getName() {
    return 'LibreOffice';
  }

  /**
   * Detect LibreOffice installation
   * @returns {Promise<{path: string, isFlatpak: boolean}|null>}
   */
  static async detect() {
    const platform = process.platform;
    const searchPaths = LibreOfficeStrategy.SEARCH_PATHS[platform] || [];

    // First, check if in PATH
    try {
      const { execSync } = require('child_process');
      const cmd = platform === 'win32' ? 'where soffice' : 'which soffice';
      const result = execSync(cmd, { encoding: 'utf8' }).trim().split('\n')[0];
      if (result) {
        return { path: result, isFlatpak: false };
      }
    } catch (e) {
      // Not in PATH, continue searching
    }

    // Check known paths
    for (const searchPath of searchPaths) {
      try {
        await fs.access(searchPath, fs.constants.X_OK);
        const isFlatpak = searchPath.includes('flatpak');
        return { path: searchPath, isFlatpak };
      } catch (e) {
        // Path not found or not executable
      }
    }

    // Check for flatpak command
    if (platform === 'linux') {
      try {
        const { execSync } = require('child_process');
        execSync('flatpak list | grep -i libreoffice', { encoding: 'utf8' });
        return { path: 'flatpak', isFlatpak: true };
      } catch (e) {
        // Flatpak not available or LibreOffice not installed
      }
    }

    return null;
  }

  /**
   * Kill stale LibreOffice processes on Linux
   */
  async killStaleProcesses() {
    if (process.platform !== 'linux') return;

    try {
      const { execSync } = require('child_process');
      execSync('pkill -f soffice.bin', { timeout: 5000 });
    } catch (e) {
      // Process not found or kill failed - that's okay
    }
  }

  /**
   * Convert PPTX to PDF using LibreOffice
   * @param {string} inputPath - Path to PPTX file
   * @param {string} outputDir - Directory to save PDF
   * @returns {Promise<{pdfPath: string}>}
   */
  async convertToPdf(inputPath, outputDir) {
    // Kill stale processes on Linux
    await this.killStaleProcesses();

    return new Promise((resolve, reject) => {
      const timeout = 300000; // 5 minutes
      let args;
      let command;

      if (this.isFlatpak && this.executablePath === 'flatpak') {
        command = 'flatpak';
        args = [
          'run', 'org.libreoffice.LibreOffice',
          '--headless',
          '--nofirststartwizard',
          '--norestore',
          '--convert-to', 'pdf',
          '--outdir', outputDir,
          inputPath
        ];
      } else {
        command = this.executablePath;
        args = [
          '--headless',
          '--nofirststartwizard',
          '--norestore',
          '--convert-to', 'pdf',
          '--outdir', outputDir,
          inputPath
        ];
      }

      const child = spawn(command, args, {
        timeout,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      child.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      const timeoutId = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('LibreOffice conversion timed out after 5 minutes'));
      }, timeout);

      child.on('close', async (code) => {
        clearTimeout(timeoutId);

        if (code !== 0) {
          reject(new Error(`LibreOffice conversion failed with code ${code}: ${stderr}`));
          return;
        }

        // Find the generated PDF
        const baseName = path.basename(inputPath, path.extname(inputPath));
        const expectedPdfPath = path.join(outputDir, `${baseName}.pdf`);

        try {
          await fs.access(expectedPdfPath);
          resolve({ pdfPath: expectedPdfPath });
        } catch (e) {
          // PDF might have different name, search for it
          const files = await fs.readdir(outputDir);
          const pdfFile = files.find(f => f.endsWith('.pdf'));

          if (pdfFile) {
            resolve({ pdfPath: path.join(outputDir, pdfFile) });
          } else {
            reject(new Error(`PDF not found after conversion. Output: ${stdout}`));
          }
        }
      });

      child.on('error', (err) => {
        clearTimeout(timeoutId);
        reject(new Error(`Failed to start LibreOffice: ${err.message}`));
      });
    });
  }
}

module.exports = LibreOfficeStrategy;
