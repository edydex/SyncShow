/**
 * PowerPoint Strategy for PPTX to PDF Conversion
 *
 * Uses Microsoft PowerPoint's COM automation via PowerShell to convert
 * PPTX files to PDF. Windows only (requires PowerPoint to be installed).
 *
 * PowerPoint is a MultiUse, single-process COM server. SyncShow therefore
 * refuses to automate it while any POWERPNT process is already running and
 * never force-terminates POWERPNT on a conversion timeout.
 */

const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs').promises;
const os = require('os');
const BaseStrategy = require('./BaseStrategy');

const POWERPOINT_IN_USE_CODE = 'POWERPOINT_IN_USE';

// PowerShell script template for conversion.
// Written to a temp file to avoid command-line escaping issues with paths.
const CONVERSION_SCRIPT = `
param([string]$InputPath, [string]$OutputPath)
$ErrorActionPreference = 'Stop'
$presentation = $null
$pptApp = $null
$powerPointPid = 0
$ownsPowerPointProcess = $false
$exitCode = 0

# PowerPoint is a MultiUse, single-instance COM server. Never call
# New-Object when an interactive/user-owned process already exists.
$preexistingPowerPointPids = @(
  Get-Process -Name POWERPNT -ErrorAction SilentlyContinue |
    ForEach-Object { [int]$_.Id }
)
if ($preexistingPowerPointPids.Count -gt 0) {
  [Console]::Error.WriteLine('__SYNCSHOW_POWERPOINT_IN_USE__: Close PowerPoint or use LibreOffice.')
  exit 2
}

try {
  $pptApp = New-Object -ComObject PowerPoint.Application

  # Defend against a user starting PowerPoint between the Node preflight and
  # COM activation. Continue only when the returned COM server is the sole new
  # POWERPNT process and it has no preexisting presentations.
  try {
    $currentPowerPointPids = @(
      Get-Process -Name POWERPNT -ErrorAction SilentlyContinue |
        ForEach-Object { [int]$_.Id }
    )
    $ownsPowerPointProcess = (
      $currentPowerPointPids.Count -eq 1 -and
      $pptApp.Presentations.Count -eq 0
    )
    if ($ownsPowerPointProcess) {
      $powerPointPid = [int]$currentPowerPointPids[0]
    }
  } catch {
    $ownsPowerPointProcess = $false
  }

  if (-not $ownsPowerPointProcess) {
    throw '__SYNCSHOW_POWERPOINT_OWNERSHIP_UNCERTAIN__: Refusing to automate a shared PowerPoint process.'
  }

  # Open read-only, not as a template, and without a presentation window.
  $presentation = $pptApp.Presentations.Open($InputPath, $true, $false, $false)
  # ppSaveAsPDF = 32; more compatible than ExportAsFixedFormat across COM versions.
  $presentation.SaveAs($OutputPath, 32)
  Write-Output 'success'
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  $exitCode = 1
} finally {
  # Close only the presentation opened by SyncShow, and never close it if it
  # acquired unsaved changes while automation was running (for example, if a
  # user opened PowerPoint during the conversion and began editing it).
  if ($null -ne $presentation) {
    $safeToClosePresentation = $false
    try { $safeToClosePresentation = ($presentation.Saved -ne 0) } catch {}
    if ($safeToClosePresentation) {
      try { $presentation.Close() } catch {}
    } else {
      $ownsPowerPointProcess = $false
    }
    try { [System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($presentation) | Out-Null } catch {}
    $presentation = $null
  }

  if ($null -ne $pptApp) {
    # Quit only if ownership is still exclusive after closing our presentation.
    # If another presentation appeared, release our COM reference and leave the
    # process untouched so no user work can be closed by SyncShow.
    $stillExclusive = $false
    if ($ownsPowerPointProcess) {
      try {
        $currentPowerPointPids = @(
          Get-Process -Name POWERPNT -ErrorAction SilentlyContinue |
            ForEach-Object { [int]$_.Id }
        )
        $stillExclusive = (
          $currentPowerPointPids.Count -eq 1 -and
          $currentPowerPointPids -contains $powerPointPid -and
          $pptApp.Presentations.Count -eq 0
        )
      } catch {
        $stillExclusive = $false
      }
    }

    if ($stillExclusive) {
      try { $pptApp.Quit() } catch {}
    }
    try { [System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($pptApp) | Out-Null } catch {}
    $pptApp = $null
  }

  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
  [GC]::Collect()
}
exit $exitCode
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

const RUNNING_PROCESS_SCRIPT = `
Get-Process -Name POWERPNT -ErrorAction SilentlyContinue |
  ForEach-Object { Write-Output $_.Id }
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

    return new Promise(resolve => {
      execFile(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-Command', DETECT_SCRIPT],
        { timeout: 10000, windowsHide: true },
        (error, stdout) => {
          if (error) { resolve(null); return; }
          const exePath = stdout.trim();
          resolve(exePath ? { path: exePath } : null);
        }
      );
    });
  }

  /**
   * Return all currently running POWERPNT process IDs. Detection failures are
   * surfaced so the caller falls back instead of assuming exclusive ownership.
   */
  async _getRunningPowerPointProcessIds() {
    return new Promise((resolve, reject) => {
      execFile(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-Command', RUNNING_PROCESS_SCRIPT],
        { timeout: 10000, windowsHide: true },
        (error, stdout, stderr) => {
          if (error) {
            reject(new Error(
              `Could not determine whether PowerPoint is already running: ` +
              `${stderr.trim() || error.message}`
            ));
            return;
          }

          const processIds = stdout
            .split(/\r?\n/)
            .map(value => Number.parseInt(value.trim(), 10))
            .filter(pid => Number.isSafeInteger(pid) && pid > 0);
          resolve([...new Set(processIds)]);
        }
      );
    });
  }

  async _assertNoPreexistingPowerPoint() {
    const processIds = await this._getRunningPowerPointProcessIds();
    if (processIds.length === 0) return;

    const error = new Error(
      'PowerPoint is already running. SyncShow will use LibreOffice to avoid closing or interrupting user presentations.'
    );
    error.code = POWERPOINT_IN_USE_CODE;
    error.processIds = processIds;
    throw error;
  }

  /**
   * Convert PPTX to PDF using PowerPoint COM automation.
   * @param {string} inputPath - Path to PPTX file
   * @param {string} outputDir - Kept for strategy API compatibility
   * @returns {Promise<{pdfPath: string, cleanup: Function}>}
   */
  async convertToPdf(inputPath, outputDir) { // eslint-disable-line no-unused-vars
    // Refuse before COM activation when a user-owned PowerPoint process exists.
    await this._assertNoPreexistingPowerPoint();

    const baseName = path.basename(inputPath, path.extname(inputPath));
    const absInput = path.resolve(inputPath);
    const pdfDir = await fs.mkdtemp(path.join(os.tmpdir(), 'syncshow-ppt-pdf-'));
    const absPdfPath = path.join(pdfDir, `${baseName}.pdf`);
    let scriptDir = null;

    try {
      scriptDir = await fs.mkdtemp(path.join(os.tmpdir(), 'syncshow-ppt-script-'));
      const tmpScript = path.join(scriptDir, 'convert.ps1');
      await fs.writeFile(tmpScript, CONVERSION_SCRIPT, 'utf8');

      const { stdout, stderr } = await new Promise((resolve, reject) => {
        const timeout = 300000; // 5 minutes
        let settled = false;
        let timedOut = false;
        let timeoutId;
        let cleanupGraceId;

        const finish = (callback, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeoutId);
          clearTimeout(cleanupGraceId);
          callback(value);
        };

        const child = execFile(
          'powershell',
          [
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy', 'Bypass',
            '-File', tmpScript,
            '-InputPath', absInput,
            '-OutputPath', absPdfPath
          ],
          { windowsHide: true },
          (error, stdout, stderr) => {
            if (timedOut) {
              finish(
                reject,
                new Error(
                  'PowerPoint conversion timed out after 5 minutes. ' +
                  'Only the SyncShow PowerShell client was stopped; PowerPoint was left untouched.'
                )
              );
              return;
            }

            if (error) {
              const detail = stderr.trim() || error.message;
              finish(reject, new Error(`PowerPoint conversion failed: ${detail}`));
              return;
            }
            finish(resolve, { stdout, stderr });
          }
        );

        timeoutId = setTimeout(() => {
          timedOut = true;
          // Never taskkill POWERPNT. PowerPoint can become user-owned while an
          // automation conversion is running because it is single-instance.
          child.kill('SIGKILL');
          cleanupGraceId = setTimeout(() => {
            child.kill('SIGKILL');
            finish(
              reject,
              new Error(
                'PowerPoint conversion timed out after 5 minutes. ' +
                'Only the SyncShow PowerShell client was stopped; PowerPoint was left untouched.'
              )
            );
          }, 5000);
        }, timeout);
      });

      try {
        const stats = await fs.stat(absPdfPath);
        if (!stats.isFile() || stats.size < 1) throw new Error('PDF is empty');
      } catch (error) {
        throw new Error(
          `PDF not found after PowerPoint conversion.\nstdout: ${stdout}\nstderr: ${stderr}`
        );
      }

      return {
        pdfPath: absPdfPath,
        cleanup: () => fs.rm(pdfDir, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 100
        })
      };
    } catch (error) {
      // Keep a timed-out/locked partial PDF outside the cache staging directory
      // so LibreOffice fallback can still publish a clean generation.
      await fs.rm(pdfDir, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100
      }).catch(cleanupError => {
        console.warn(`[PowerPoint] Could not clean temporary PDF ${pdfDir}: ${cleanupError.message}`);
      });
      throw error;
    } finally {
      if (scriptDir) {
        await fs.rm(scriptDir, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 100
        }).catch(error => {
          console.warn(`[PowerPoint] Could not clean temporary script ${scriptDir}: ${error.message}`);
        });
      }
    }
  }
}

PowerPointStrategy.POWERPOINT_IN_USE_CODE = POWERPOINT_IN_USE_CODE;

module.exports = PowerPointStrategy;
