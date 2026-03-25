/**
 * PowerPoint Strategy for PPTX to PDF Conversion
 *
 * Uses Microsoft PowerPoint's COM automation via PowerShell to convert
 * PPTX files to PDF. Windows only (requires PowerPoint to be installed).
 */

const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs').promises;
const os = require('os');
const BaseStrategy = require('./BaseStrategy');

// PowerShell script template for conversion.
// Written to a temp file to avoid command-line escaping issues with paths.
const CONVERSION_SCRIPT = `
param([string]$InputPath, [string]$OutputPath)
$ErrorActionPreference = 'Stop'
try {
  $pptApp = New-Object -ComObject PowerPoint.Application
  # Open read-only, not as template, not visible (AddToMRU = false)
  $presentation = $pptApp.Presentations.Open($InputPath, $true, $false, $false)
  # ppFixedFormatTypePDF = 2
  $presentation.ExportAsFixedFormat($OutputPath, 2)
  $presentation.Close()
  $pptApp.Quit()
  [System.Runtime.InteropServices.Marshal]::ReleaseComObject($presentation) | Out-Null
  [System.Runtime.InteropServices.Marshal]::ReleaseComObject($pptApp) | Out-Null
  [GC]::Collect()
  Write-Output 'success'
} catch {
  Write-Error $_.Exception.Message
  exit 1
}
`.trimStart();

// PowerShell snippet to locate POWERPNT.EXE via the Windows App Paths registry key.
const DETECT_SCRIPT = `
try {
  $key = Get-ItemProperty -Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\POWERPNT.EXE' -ErrorAction Stop
  Write-Output $key.'(Default)'
} catch {
  try {
    $key = Get-ItemProperty -Path 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\POWERPNT.EXE' -ErrorAction Stop
    Write-Output $key.'(Default)'
  } catch {
    Write-Output ''
  }
}
`.trimStart();

class PowerPointStrategy extends BaseStrategy {
  constructor(executablePath) {
    super(executablePath);
  }

  getName() {
    return 'PowerPoint';
  }

  /**
   * Detect whether Microsoft PowerPoint is installed on this Windows machine.
   * @returns {Promise<{path: string}|null>}
   */
  static async detect() {
    if (process.platform !== 'win32') return null;

    return new Promise((resolve) => {
      execFile(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-Command', DETECT_SCRIPT],
        { timeout: 10000 },
        (error, stdout) => {
          if (error) { resolve(null); return; }
          const exePath = stdout.trim();
          resolve(exePath ? { path: exePath } : null);
        }
      );
    });
  }

  /**
   * Convert PPTX to PDF using PowerPoint COM automation.
   * @param {string} inputPath - Path to PPTX file
   * @param {string} outputDir - Directory to save PDF
   * @returns {Promise<{pdfPath: string}>}
   */
  async convertToPdf(inputPath, outputDir) {
    const baseName = path.basename(inputPath, path.extname(inputPath));
    const absInput = path.resolve(inputPath);
    const absPdfPath = path.resolve(path.join(outputDir, `${baseName}.pdf`));

    // Write the script to a temp file — avoids all path escaping headaches.
    const tmpScript = path.join(os.tmpdir(), `syncshow-ppt-${Date.now()}.ps1`);
    await fs.writeFile(tmpScript, CONVERSION_SCRIPT, 'utf8');

    return new Promise((resolve, reject) => {
      const timeout = 300000; // 5 minutes

      const timeoutId = setTimeout(() => {
        reject(new Error('PowerPoint conversion timed out after 5 minutes'));
      }, timeout);

      execFile(
        'powershell',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy', 'Bypass',
          '-File', tmpScript,
          '-InputPath', absInput,
          '-OutputPath', absPdfPath
        ],
        { timeout },
        async (error, stdout, stderr) => {
          clearTimeout(timeoutId);
          fs.unlink(tmpScript).catch(() => {});

          if (error) {
            reject(new Error(
              `PowerPoint conversion failed: ${stderr.trim() || error.message}`
            ));
            return;
          }

          try {
            await fs.access(absPdfPath);
            resolve({ pdfPath: absPdfPath });
          } catch (e) {
            reject(new Error(
              `PDF not found after PowerPoint conversion.\nstdout: ${stdout}\nstderr: ${stderr}`
            ));
          }
        }
      );
    });
  }
}

module.exports = PowerPointStrategy;
