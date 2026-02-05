#!/usr/bin/env node

/**
 * Setup Ghostscript - Downloads portable Ghostscript for the current platform
 *
 * Supports:
 * - Windows x64: Ghostscript from official releases
 * - macOS x64/arm64: Ghostscript from official releases
 * - Linux x64: Ghostscript from official releases
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const os = require('os');

const GS_VERSION = '10.04.0';
const GS_VERSION_SHORT = '10040'; // For Windows filename

// Download URLs by platform
const DOWNLOAD_URLS = {
  'win32-x64': `https://github.com/ArtifexSoftware/ghostpdl-downloads/releases/download/gs${GS_VERSION_SHORT}/gs${GS_VERSION_SHORT}w64.exe`,
  'darwin-x64': `https://github.com/ArtifexSoftware/ghostpdl-downloads/releases/download/gs${GS_VERSION_SHORT}/ghostscript-${GS_VERSION}-macos-x86_64.pkg`,
  'darwin-arm64': `https://github.com/ArtifexSoftware/ghostpdl-downloads/releases/download/gs${GS_VERSION_SHORT}/ghostscript-${GS_VERSION}-macos-arm64.pkg`,
  'linux-x64': `https://github.com/ArtifexSoftware/ghostpdl-downloads/releases/download/gs${GS_VERSION_SHORT}/ghostscript-${GS_VERSION}-linux-x86_64.tgz`
};

const platform = process.platform;
const arch = process.arch;
const platformKey = `${platform}-${arch}`;

const projectRoot = path.join(__dirname, '..');
const outputDir = path.join(projectRoot, 'ghostscript-embed', platformKey);

function log(msg) {
  console.log(`[setup-ghostscript] ${msg}`);
}

function error(msg) {
  console.error(`[setup-ghostscript] ERROR: ${msg}`);
}

/**
 * Download a file with redirect support
 */
function download(url, dest) {
  return new Promise((resolve, reject) => {
    log(`Downloading ${url}`);

    const file = fs.createWriteStream(dest);
    const protocol = url.startsWith('https') ? https : http;

    const request = protocol.get(url, {
      headers: {
        'User-Agent': 'SyncShow-Setup/1.0'
      }
    }, (response) => {
      // Handle redirects
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        log(`Following redirect to ${response.headers.location}`);
        file.close();
        fs.unlinkSync(dest);
        download(response.headers.location, dest).then(resolve).catch(reject);
        return;
      }

      if (response.statusCode !== 200) {
        file.close();
        fs.unlinkSync(dest);
        reject(new Error(`Download failed with status ${response.statusCode}`));
        return;
      }

      const totalSize = parseInt(response.headers['content-length'], 10);
      let downloadedSize = 0;

      response.on('data', (chunk) => {
        downloadedSize += chunk.length;
        if (totalSize) {
          const percent = Math.round((downloadedSize / totalSize) * 100);
          process.stdout.write(`\r[setup-ghostscript] Progress: ${percent}%`);
        }
      });

      response.pipe(file);

      file.on('finish', () => {
        console.log(''); // New line after progress
        file.close();
        resolve();
      });
    });

    request.on('error', (err) => {
      file.close();
      fs.unlinkSync(dest);
      reject(err);
    });
  });
}

async function setupWindows() {
  log('Setting up Ghostscript for Windows...');

  // For Windows, download and extract using 7z or similar
  // The .exe is actually a self-extracting archive
  const url = DOWNLOAD_URLS[platformKey];
  const exePath = path.join(os.tmpdir(), 'ghostscript-setup.exe');

  try {
    await download(url, exePath);

    fs.mkdirSync(outputDir, { recursive: true });

    // Try to extract using 7z (if available) or run silent install
    try {
      log('Extracting with 7z...');
      execSync(`7z x "${exePath}" -o"${outputDir}" -y`, { stdio: 'inherit' });
    } catch (e) {
      // Fallback: use the installer in silent mode to a temp location, then copy
      log('7z not available, using silent installer...');
      const tempInstallDir = path.join(os.tmpdir(), 'gs-temp');
      try {
        execSync(`"${exePath}" /S /D=${tempInstallDir}`, { stdio: 'inherit', timeout: 120000 });
        // Copy from temp to our directory
        execSync(`xcopy "${tempInstallDir}\\*" "${outputDir}\\" /E /I /Y`, { stdio: 'inherit' });
        // Cleanup temp
        execSync(`rmdir /s /q "${tempInstallDir}"`, { stdio: 'ignore' });
      } catch (installError) {
        throw new Error('Failed to install Ghostscript. Please install manually.');
      }
    }

    fs.unlinkSync(exePath);
    log('Windows Ghostscript setup complete!');
  } catch (e) {
    error(`Windows setup failed: ${e.message}`);
    log('Please download Ghostscript manually from https://ghostscript.com/releases/gsdnld.html');
    log(`Extract to: ${outputDir}`);
    process.exit(1);
  }
}

async function setupMac() {
  log('Setting up Ghostscript for macOS...');

  // For macOS, try to use Homebrew first (easier)
  try {
    log('Attempting to install via Homebrew...');
    execSync('brew install ghostscript', { stdio: 'inherit' });

    // Create our directory and symlink to the homebrew installation
    fs.mkdirSync(path.join(outputDir, 'bin'), { recursive: true });

    // Find the gs binary
    const gsPath = execSync('which gs', { encoding: 'utf8' }).trim();
    const gsLibPath = execSync('brew --prefix ghostscript', { encoding: 'utf8' }).trim();

    // Create symlinks
    const binDir = path.join(outputDir, 'bin');
    fs.symlinkSync(gsPath, path.join(binDir, 'gs'));

    // Copy lib directory
    const libSrc = path.join(gsLibPath, 'share', 'ghostscript');
    if (fs.existsSync(libSrc)) {
      execSync(`cp -R "${libSrc}" "${path.join(outputDir, 'lib')}"`, { stdio: 'inherit' });
    }

    log('macOS Ghostscript setup complete (via Homebrew)!');
    return;
  } catch (e) {
    log('Homebrew installation failed, trying direct download...');
  }

  // Fallback to direct download
  const url = DOWNLOAD_URLS[platformKey];
  if (!url) {
    error(`No download URL for ${platformKey}`);
    process.exit(1);
  }

  const pkgPath = path.join(os.tmpdir(), 'ghostscript.pkg');

  try {
    await download(url, pkgPath);

    fs.mkdirSync(outputDir, { recursive: true });

    // Extract pkg (macOS)
    log('Extracting pkg...');
    const payloadDir = path.join(os.tmpdir(), 'gs-payload');
    fs.mkdirSync(payloadDir, { recursive: true });

    execSync(`pkgutil --expand "${pkgPath}" "${payloadDir}"`, { stdio: 'inherit' });

    // Find and extract the payload
    const payloadPath = path.join(payloadDir, 'ghostscript.pkg', 'Payload');
    if (fs.existsSync(payloadPath)) {
      execSync(`cd "${outputDir}" && cat "${payloadPath}" | gzip -d | cpio -id`, { stdio: 'inherit' });
    }

    // Cleanup
    fs.unlinkSync(pkgPath);
    execSync(`rm -rf "${payloadDir}"`, { stdio: 'ignore' });

    log('macOS Ghostscript setup complete!');
  } catch (e) {
    error(`macOS setup failed: ${e.message}`);
    log('Please install Ghostscript manually: brew install ghostscript');
    process.exit(1);
  }
}

async function setupLinux() {
  log('Setting up Ghostscript for Linux...');

  const url = DOWNLOAD_URLS[platformKey];
  if (!url) {
    error(`No download URL for ${platformKey}`);
    process.exit(1);
  }

  const tgzPath = path.join(os.tmpdir(), 'ghostscript.tgz');

  try {
    await download(url, tgzPath);

    fs.mkdirSync(outputDir, { recursive: true });

    // Extract tar.gz
    log('Extracting tar.gz...');
    execSync(`tar -xzf "${tgzPath}" -C "${outputDir}" --strip-components=1`, { stdio: 'inherit' });

    // Make binaries executable
    const binDir = path.join(outputDir, 'bin');
    if (fs.existsSync(binDir)) {
      const files = fs.readdirSync(binDir);
      for (const file of files) {
        fs.chmodSync(path.join(binDir, file), 0o755);
      }
    }

    // Also check for gs-* binaries in root
    const rootFiles = fs.readdirSync(outputDir);
    for (const file of rootFiles) {
      if (file.startsWith('gs')) {
        const filePath = path.join(outputDir, file);
        if (!fs.statSync(filePath).isDirectory()) {
          fs.chmodSync(filePath, 0o755);
        }
      }
    }

    fs.unlinkSync(tgzPath);
    log('Linux Ghostscript setup complete!');
  } catch (e) {
    error(`Linux setup failed: ${e.message}`);
    log('Trying alternative: apt install ghostscript');
    try {
      execSync('sudo apt-get install -y ghostscript', { stdio: 'inherit' });
      log('Installed via apt');

      // Create symlinks to system installation
      fs.mkdirSync(path.join(outputDir, 'bin'), { recursive: true });
      fs.symlinkSync('/usr/bin/gs', path.join(outputDir, 'bin', 'gs'));
    } catch (aptError) {
      log('Please install Ghostscript manually: sudo apt install ghostscript');
      process.exit(1);
    }
  }
}

async function main() {
  log(`Platform: ${platform}, Arch: ${arch}`);
  log(`Output directory: ${outputDir}`);

  // Check if already installed
  const gsPath = path.join(outputDir, 'bin', platform === 'win32' ? 'gswin64c.exe' : 'gs');
  const altGsPath = path.join(outputDir, platform === 'win32' ? 'bin/gswin64c.exe' : 'gs');

  if (fs.existsSync(gsPath) || fs.existsSync(altGsPath)) {
    log('Ghostscript already installed, skipping...');
    return;
  }

  switch (platform) {
    case 'win32':
      await setupWindows();
      break;
    case 'darwin':
      await setupMac();
      break;
    case 'linux':
      await setupLinux();
      break;
    default:
      error(`Unsupported platform: ${platform}`);
      process.exit(1);
  }

  log('Setup complete!');
}

main().catch((e) => {
  error(e.message);
  process.exit(1);
});
