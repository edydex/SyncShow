/**
 * LibreOffice Strategy for PPTX to PDF Conversion
 *
 * Uses LibreOffice in headless mode to convert PPTX to PDF.
 * Supports standard installations, snap, and flatpak on Linux.
 */

const { spawn } = require('child_process');
const { pathToFileURL } = require('url');
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
   * Detect LibreOffice installation.
   * @returns {Promise<{path: string, isFlatpak: boolean}|null>}
   */
  static async detect() {
    const platform = process.platform;
    const searchPaths = LibreOfficeStrategy.SEARCH_PATHS[platform] || [];

    // First, check if in PATH.
    try {
      const { execSync } = require('child_process');
      const cmd = platform === 'win32' ? 'where soffice' : 'which soffice';
      const result = execSync(cmd, { encoding: 'utf8' }).trim().split(/\r?\n/)[0];
      if (result) {
        return { path: result, isFlatpak: false };
      }
    } catch (error) {
      // Not in PATH, continue searching.
    }

    // Check known paths.
    for (const searchPath of searchPaths) {
      try {
        await fs.access(searchPath, fs.constants.X_OK);
        const isFlatpak = searchPath.includes('flatpak');
        return { path: searchPath, isFlatpak };
      } catch (error) {
        // Path not found or not executable.
      }
    }

    // Check for a Flatpak installation when no exported launcher was found.
    if (platform === 'linux') {
      try {
        const { execFileSync } = require('child_process');
        const applications = execFileSync('flatpak', ['list', '--app', '--columns=application'], {
          encoding: 'utf8',
          timeout: 10000
        });
        if (applications.split(/\r?\n/).includes('org.libreoffice.LibreOffice')) {
          return { path: 'flatpak', isFlatpak: true };
        }
      } catch (error) {
        // Flatpak is unavailable or LibreOffice is not installed.
      }
    }

    return null;
  }

  /**
   * Run only the LibreOffice child created for this conversion. The isolated
   * user profile prevents it from attaching to any interactive LibreOffice
   * process, so no system-wide process termination is necessary.
   */
  async _terminateChildTree(child) {
    if (!child.pid) {
      child.kill('SIGKILL');
      return;
    }

    if (process.platform !== 'win32') {
      try {
        // The child is spawned as a detached process-group leader below. A
        // negative PID therefore targets only this conversion's process group,
        // including a soffice.bin child created by a launcher script.
        process.kill(-child.pid, 'SIGKILL');
      } catch (error) {
        child.kill('SIGKILL');
      }
      return;
    }

    // On Windows, taskkill /T terminates only the tree rooted at this exact PID.
    // It is intentionally scoped and is not a global LibreOffice kill.
    await new Promise(resolve => {
      const killer = spawn(
        'taskkill',
        ['/PID', String(child.pid), '/T', '/F'],
        { stdio: 'ignore', windowsHide: true }
      );
      let settled = false;
      let timer;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      timer = setTimeout(() => {
        killer.kill('SIGKILL');
        child.kill('SIGKILL');
        finish();
      }, 5000);

      killer.on('close', code => {
        if (code !== 0) {
          child.kill('SIGKILL');
        }
        finish();
      });
      killer.on('error', () => {
        child.kill('SIGKILL');
        finish();
      });
    });
  }

  async _runConversion(command, args, timeout = 300000, terminationGrace = 5000) {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32'
      });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;
      let timeoutId;
      let killGraceId;

      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        clearTimeout(killGraceId);
        callback(value);
      };

      child.stdout.on('data', data => {
        stdout += data.toString();
      });

      child.stderr.on('data', data => {
        stderr += data.toString();
      });

      timeoutId = setTimeout(() => {
        timedOut = true;
        this._terminateChildTree(child)
          .catch(error => {
            console.warn(`[LibreOffice] Could not terminate conversion tree: ${error.message}`);
          })
          .finally(() => {
            if (settled) return;
            // Do not wait forever for a missing close event after termination.
            killGraceId = setTimeout(() => {
              finish(reject, new Error('LibreOffice conversion timed out after 5 minutes'));
            }, terminationGrace);
          });
      }, timeout);

      child.on('close', (code, signal) => {
        if (timedOut) {
          finish(reject, new Error('LibreOffice conversion timed out after 5 minutes'));
          return;
        }

        if (code !== 0) {
          finish(
            reject,
            new Error(
              `LibreOffice conversion failed with code ${code}` +
              `${signal ? ` (signal ${signal})` : ''}.\nstdout: ${stdout}\nstderr: ${stderr}`
            )
          );
          return;
        }

        finish(resolve, { stdout, stderr });
      });

      child.on('error', error => {
        finish(reject, new Error(`Failed to start LibreOffice: ${error.message}`));
      });
    });
  }

  /**
   * Convert PPTX to PDF using LibreOffice.
   * @param {string} inputPath - Path to PPTX file
   * @param {string} outputDir - Kept for strategy API compatibility
   * @returns {Promise<{pdfPath: string, cleanup: Function}>}
   */
  async convertToPdf(inputPath, outputDir) { // eslint-disable-line no-unused-vars
    // Fresh output and profile directories prevent stale PDFs and prevent this
    // headless instance from joining an existing user's LibreOffice process.
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'syncshow-pdf-'));
    let profileDir;

    try {
      profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'syncshow-lo-profile-'));
      const profileUrl = pathToFileURL(profileDir).href;
      let args;
      let command;

      if (this.isFlatpak && this.executablePath === 'flatpak') {
        command = 'flatpak';
        args = [
          'run', 'org.libreoffice.LibreOffice',
          '--headless',
          '--nofirststartwizard',
          '--norestore',
          `-env:UserInstallation=${profileUrl}`,
          '--convert-to', 'pdf',
          '--outdir', tmpDir,
          inputPath
        ];
      } else {
        command = this.executablePath;
        args = [
          '--headless',
          '--nofirststartwizard',
          '--norestore',
          `-env:UserInstallation=${profileUrl}`,
          '--convert-to', 'pdf',
          '--outdir', tmpDir,
          inputPath
        ];
      }

      const { stdout, stderr } = await this._runConversion(command, args);
      const baseName = path.basename(inputPath, path.extname(inputPath));
      const expectedPdfPath = path.join(tmpDir, `${baseName}.pdf`);
      let pdfPath = expectedPdfPath;

      if (!(await pathExists(expectedPdfPath))) {
        // The only PDF in this fresh directory must belong to this conversion.
        const files = await fs.readdir(tmpDir);
        const pdfFile = files.find(file => file.toLowerCase().endsWith('.pdf'));

        if (!pdfFile) {
          throw new Error(
            `PDF not found after conversion.\nstdout: ${stdout}\nstderr: ${stderr}`
          );
        }
        pdfPath = path.join(tmpDir, pdfFile);
      }

      return {
        pdfPath,
        cleanup: () => fs.rm(tmpDir, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 100
        })
      };
    } catch (error) {
      await fs.rm(tmpDir, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100
      }).catch(cleanupError => {
        console.warn(`[LibreOffice] Could not clean ${tmpDir}: ${cleanupError.message}`);
      });
      throw error;
    } finally {
      if (profileDir) {
        await fs.rm(profileDir, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 100
        }).catch(error => {
          console.warn(`[LibreOffice] Could not clean profile ${profileDir}: ${error.message}`);
        });
      }
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

module.exports = LibreOfficeStrategy;
