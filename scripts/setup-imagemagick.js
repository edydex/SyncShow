#!/usr/bin/env node

/**
 * Setup ImageMagick - Downloads portable ImageMagick for the current platform
 *
 * Supports:
 * - Windows x64: ImageMagick portable from GitHub releases
 * - macOS x64/arm64: ImageMagick from GitHub releases
 * - Linux x64: ImageMagick AppImage from GitHub releases
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync, exec } = require('child_process');
const os = require('os');

const IMAGEMAGICK_VERSION = '7.1.1-43';

// Download URLs by platform
const DOWNLOAD_URLS = {
  'win32-x64': `https://imagemagick.org/archive/binaries/ImageMagick-${IMAGEMAGICK_VERSION}-Q16-HDRI-x64-dll.exe`,
  'darwin-x64': `https://github.com/ImageMagick/ImageMagick/releases/download/${IMAGEMAGICK_VERSION}/ImageMagick-${IMAGEMAGICK_VERSION.replace('-', '.')}.x86_64.tar.gz`,
  'darwin-arm64': `https://github.com/ImageMagick/ImageMagick/releases/download/${IMAGEMAGICK_VERSION}/ImageMagick-${IMAGEMAGICK_VERSION.replace('-', '.')}.aarch64.tar.gz`,
  'linux-x64': `https://imagemagick.org/archive/binaries/magick`
};

const platform = process.platform;
const arch = process.arch;
const platformKey = `${platform}-${arch}`;

const projectRoot = path.join(__dirname, '..');
const outputDir = path.join(projectRoot, 'imagemagick-embed', platformKey);

function log(msg) {
  console.log(`[setup-imagemagick] ${msg}`);
}

function error(msg) {
  console.error(`[setup-imagemagick] ERROR: ${msg}`);
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
          process.stdout.write(`\r[setup-imagemagick] Progress: ${percent}%`);
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

/**
 * Extract archive based on type
 */
async function extract(archivePath, destDir) {
  const ext = path.extname(archivePath).toLowerCase();

  if (ext === '.gz' || archivePath.endsWith('.tar.gz')) {
    log('Extracting tar.gz archive...');
    execSync(`tar -xzf "${archivePath}" -C "${destDir}"`, { stdio: 'inherit' });
  } else if (ext === '.zip') {
    log('Extracting zip archive...');
    if (platform === 'win32') {
      execSync(`powershell -Command "Expand-Archive -Path '${archivePath}' -DestinationPath '${destDir}' -Force"`, { stdio: 'inherit' });
    } else {
      execSync(`unzip -o "${archivePath}" -d "${destDir}"`, { stdio: 'inherit' });
    }
  } else if (ext === '.7z') {
    log('Extracting 7z archive...');
    execSync(`7z x "${archivePath}" -o"${destDir}" -y`, { stdio: 'inherit' });
  } else {
    log('No extraction needed (single file)');
  }
}

async function setupWindows() {
  log('Setting up ImageMagick for Windows...');

  // For Windows, we'll download the portable zip version instead of the installer
  const portableUrl = `https://imagemagick.org/archive/binaries/ImageMagick-${IMAGEMAGICK_VERSION}-portable-Q16-HDRI-x64.zip`;
  const zipPath = path.join(os.tmpdir(), 'imagemagick-portable.zip');

  try {
    await download(portableUrl, zipPath);

    fs.mkdirSync(outputDir, { recursive: true });
    await extract(zipPath, outputDir);

    // Move files from nested directory if needed
    const entries = fs.readdirSync(outputDir);
    if (entries.length === 1 && fs.statSync(path.join(outputDir, entries[0])).isDirectory()) {
      const nestedDir = path.join(outputDir, entries[0]);
      const nestedFiles = fs.readdirSync(nestedDir);
      for (const file of nestedFiles) {
        fs.renameSync(path.join(nestedDir, file), path.join(outputDir, file));
      }
      fs.rmdirSync(nestedDir);
    }

    fs.unlinkSync(zipPath);
    log('Windows ImageMagick setup complete!');
  } catch (e) {
    error(`Windows setup failed: ${e.message}`);
    log('Please download ImageMagick portable manually from https://imagemagick.org/script/download.php');
    log(`Extract to: ${outputDir}`);
    process.exit(1);
  }
}

async function setupMac() {
  log('Setting up ImageMagick for macOS...');

  const url = DOWNLOAD_URLS[platformKey];
  if (!url) {
    error(`No download URL for ${platformKey}`);
    process.exit(1);
  }

  const tarPath = path.join(os.tmpdir(), 'imagemagick.tar.gz');

  try {
    await download(url, tarPath);

    fs.mkdirSync(outputDir, { recursive: true });
    await extract(tarPath, outputDir);

    // Make binaries executable
    const binDir = outputDir;
    const files = fs.readdirSync(binDir);
    for (const file of files) {
      const filePath = path.join(binDir, file);
      if (!fs.statSync(filePath).isDirectory()) {
        try {
          fs.chmodSync(filePath, 0o755);
        } catch (e) {
          // Ignore permission errors
        }
      }
    }

    fs.unlinkSync(tarPath);
    log('macOS ImageMagick setup complete!');
  } catch (e) {
    error(`macOS setup failed: ${e.message}`);
    log('Trying alternative: brew install imagemagick');
    try {
      execSync('brew install imagemagick', { stdio: 'inherit' });
      log('Installed via Homebrew');
    } catch (brewError) {
      log('Please install ImageMagick manually: brew install imagemagick');
      process.exit(1);
    }
  }
}

async function setupLinux() {
  log('Setting up ImageMagick for Linux...');

  // Download the standalone magick binary (AppImage-like)
  const url = DOWNLOAD_URLS[platformKey];
  if (!url) {
    error(`No download URL for ${platformKey}`);
    process.exit(1);
  }

  fs.mkdirSync(outputDir, { recursive: true });
  const magickPath = path.join(outputDir, 'magick');

  try {
    await download(url, magickPath);

    // Make executable
    fs.chmodSync(magickPath, 0o755);

    // Create symlinks for common commands
    const commands = ['convert', 'identify', 'mogrify', 'composite'];
    for (const cmd of commands) {
      const cmdPath = path.join(outputDir, cmd);
      try {
        if (fs.existsSync(cmdPath)) fs.unlinkSync(cmdPath);
        fs.symlinkSync('magick', cmdPath);
      } catch (e) {
        // Symlink creation might fail, that's okay
      }
    }

    log('Linux ImageMagick setup complete!');
  } catch (e) {
    error(`Linux setup failed: ${e.message}`);
    log('Trying alternative: apt install imagemagick');
    try {
      execSync('sudo apt-get install -y imagemagick', { stdio: 'inherit' });
      log('Installed via apt');
    } catch (aptError) {
      log('Please install ImageMagick manually: sudo apt install imagemagick');
      process.exit(1);
    }
  }
}

async function main() {
  log(`Platform: ${platform}, Arch: ${arch}`);
  log(`Output directory: ${outputDir}`);

  // Check if already installed
  const magickPath = path.join(outputDir, platform === 'win32' ? 'magick.exe' : 'magick');
  if (fs.existsSync(magickPath)) {
    log('ImageMagick already installed, skipping...');
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
