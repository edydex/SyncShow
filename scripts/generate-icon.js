/**
 * Script to generate app icon for SyncShow
 * Run with: node scripts/generate-icon.js
 */

const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const assetsDir = path.join(__dirname, '..', 'assets');

// Create a simple icon: blue gradient background with "SS" text overlay
async function generateIcon() {
  // Create SVG for the icon
  const svg = `
    <svg width="256" height="256" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" style="stop-color:#4a9eff;stop-opacity:1" />
          <stop offset="100%" style="stop-color:#1e40af;stop-opacity:1" />
        </linearGradient>
      </defs>
      <rect width="256" height="256" rx="40" fill="url(#bg)"/>
      <text x="128" y="170" font-family="Segoe UI, Arial, sans-serif" font-size="120" font-weight="bold" fill="white" text-anchor="middle">SS</text>
    </svg>
  `;

  // Generate PNG at various sizes for ICO
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  
  console.log('Generating icon PNGs...');
  
  for (const size of sizes) {
    await sharp(Buffer.from(svg))
      .resize(size, size)
      .png()
      .toFile(path.join(assetsDir, `icon-${size}.png`));
    console.log(`  Created icon-${size}.png`);
  }

  // Create the main 256x256 PNG
  await sharp(Buffer.from(svg))
    .resize(256, 256)
    .png()
    .toFile(path.join(assetsDir, 'icon.png'));
  console.log('  Created icon.png');

  // Create ICO file manually (simple ICO format)
  await createIcoFile(sizes, assetsDir);

  console.log('\nIcon files generated successfully!');
}

async function createIcoFile(sizes, outputDir) {
  const { imagesToIco } = require('png-to-ico');
  
  // Read all PNG files as buffers
  const pngBuffers = sizes.map(size => 
    fs.readFileSync(path.join(outputDir, `icon-${size}.png`))
  );
  
  try {
    const icoBuffer = await imagesToIco(pngBuffers);
    fs.writeFileSync(path.join(outputDir, 'icon.ico'), icoBuffer);
    console.log('  Created icon.ico');
  } catch (err) {
    console.error('Error creating ICO:', err.message);
    console.log('  Falling back to 256px PNG for icon');
    // Copy the 256 PNG as fallback
    fs.copyFileSync(
      path.join(outputDir, 'icon-256.png'),
      path.join(outputDir, 'icon.ico')
    );
  }
}

generateIcon().catch(console.error);
