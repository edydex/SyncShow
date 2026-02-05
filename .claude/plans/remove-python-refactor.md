# Plan: Remove Python from SyncShow Conversion Pipeline

## Progress

**Completed:**
- [x] Phase 1: Core Infrastructure (directory structure, npm deps, setup scripts, PlatformDetector, BaseStrategy)
- [x] Phase 2: LibreOffice Strategy
- [x] Phase 3: PDF to Image Processing (PdfToImageConverter, ThumbnailGenerator)
- [x] Phase 4: Text Extraction & Metadata (TextExtractor)
- [x] Phase 5: Main Converter & Integration (Converter.js, main.js integration)
- [x] Documentation updates (CLAUDE.md, copilot-instructions.md)

**Remaining:**
- [ ] Phase 6: Cleanup Python files (python/, python-embed/, setup scripts)
- [ ] Update package.json electron-builder config for bundled binaries
- [ ] Final testing with actual PPTX files
- [ ] Test bundled app on fresh machine

---

## Overview

Replace the Python-based PPTX converter (`python/converter.py`) with a pure Node.js solution using:
- **PPTX → PDF**: LibreOffice (strategy pattern allows future PowerPoint addition)
- **PDF → JPEG**: ImageMagick with Ghostscript via `gm` library
- **Text Extraction**: `pptx-parser` or `pptxtojson` for slide-level text extraction
- **Thumbnails**: `sharp` (already installed)

## Design Decisions

1. **LibreOffice only** for initial implementation, but strategy pattern allows adding PowerPoint later
2. **`gm` library** for ImageMagick - provides clean async API and error handling
3. **`pptxtojson`** for text extraction - gives slide-level control needed for singer screen
4. **Bundle ImageMagick + Ghostscript** with the app - only LibreOffice remains as external dependency

## Bundled Dependencies

| Component | Source | Approx Size |
|-----------|--------|-------------|
| ImageMagick 7.x | [GitHub Releases](https://github.com/ImageMagick/ImageMagick/releases) portable builds | ~80-120 MB |
| Ghostscript 10.x | [Official releases](https://ghostscript.com/releases/gsdnld.html) | ~50-60 MB |

**User-installed:** LibreOffice only (for PPTX → PDF conversion)

---

## Phase 1: Core Infrastructure

### Step 1.1: Create directory structure
Create `src/services/converter/` with subdirectories:
```
src/services/converter/
├── index.js                    # Main entry point
├── Converter.js                # Orchestrator class (EventEmitter)
├── strategies/
│   ├── BaseStrategy.js         # Abstract base class
│   └── LibreOfficeStrategy.js  # LibreOffice implementation
├── PdfToImageConverter.js      # PDF → JPEG via gm (ImageMagick)
├── TextExtractor.js            # PPTX text extraction via pptxtojson
├── ThumbnailGenerator.js       # Thumbnail generation via sharp
└── PlatformDetector.js         # Auto-detect LibreOffice
```
Note: Strategy pattern allows adding `PowerPointStrategy.js` in the future.

### Step 1.2: Add npm dependencies
```bash
npm install pptxtojson gm
```
- `pptxtojson` - Parse PPTX with slide-level structure
- `gm` - GraphicsMagick/ImageMagick wrapper for Node.js
- `sharp` - Already present for thumbnails

### Step 1.3: Create setup scripts for bundled binaries

**scripts/setup-imagemagick.js** (cross-platform Node.js script):
```javascript
// Downloads ImageMagick portable for current platform
// Windows: ImageMagick-7.x-portable-Q16-HDRI-x64.7z from GitHub releases
// macOS: imagemagick-darwin-static npm package or GitHub release
// Linux: ImageMagick-7.x-x86_64.AppImage or portable tar
```

**scripts/setup-ghostscript.js** (cross-platform Node.js script):
```javascript
// Downloads Ghostscript for current platform
// Windows: ghostscript portable from official releases
// macOS/Linux: ghostscript binaries from official releases
```

Add npm scripts:
```json
"setup-imagemagick": "node scripts/setup-imagemagick.js",
"setup-ghostscript": "node scripts/setup-ghostscript.js",
"setup-deps": "npm run setup-imagemagick && npm run setup-ghostscript"
```

**Directory structure for bundled binaries:**
```
imagemagick-embed/
├── win32-x64/
│   ├── magick.exe
│   └── ... (libs, delegates.xml)
├── darwin-x64/
│   └── ...
├── darwin-arm64/
│   └── ...
└── linux-x64/
    └── ...

ghostscript-embed/
├── win32-x64/
│   ├── bin/gswin64c.exe
│   └── lib/
├── darwin-x64/
│   └── ...
├── darwin-arm64/
│   └── ...
└── linux-x64/
    └── ...
```

### Step 1.4: Implement PlatformDetector.js
Detect LibreOffice on all platforms (and bundled ImageMagick/Ghostscript):

**Windows paths:**
- `C:\Program Files\LibreOffice\program\soffice.exe`
- `C:\Program Files (x86)\LibreOffice\program\soffice.exe`
- `%LOCALAPPDATA%\Programs\LibreOffice\program\soffice.exe`

**macOS paths:**
- `/Applications/LibreOffice.app/Contents/MacOS/soffice`
- `~/Applications/LibreOffice.app/Contents/MacOS/soffice`

**Linux paths:**
- `/usr/bin/soffice`, `/usr/bin/libreoffice`
- `/usr/local/bin/soffice`
- `/snap/bin/libreoffice`
- `/var/lib/flatpak/exports/bin/org.libreoffice.LibreOffice`
- `~/.local/share/flatpak/exports/bin/org.libreoffice.LibreOffice`

Also check PATH using `which` (Unix) / `where` (Windows).

**For bundled ImageMagick/Ghostscript:**
```javascript
function getBundledPath(tool) {
  const platform = process.platform;  // 'win32', 'darwin', 'linux'
  const arch = process.arch;          // 'x64', 'arm64'
  const platformDir = `${platform}-${arch}`;

  if (isPackaged) {
    return path.join(process.resourcesPath, `${tool}-embed`, platformDir);
  } else {
    return path.join(__dirname, `${tool}-embed`, platformDir);
  }
}
```

### Step 1.5: Implement BaseStrategy.js
Abstract base class defining the interface:
```javascript
class BaseStrategy {
  constructor(executablePath) { this.executablePath = executablePath; }
  async convertToPdf(inputPath, outputDir) { throw new Error('Not implemented'); }
  static async detect() { throw new Error('Not implemented'); }
  getName() { throw new Error('Not implemented'); }
}
```

---

## Phase 2: LibreOffice Strategy

### Step 2.1: Implement LibreOfficeStrategy.js
- Spawn `soffice --headless --convert-to pdf --outdir <dir> <input.pptx>`
- Handle flatpak: `flatpak run org.libreoffice.LibreOffice --headless ...`
- Handle snap: `/snap/bin/libreoffice --headless ...`
- Kill stale `soffice.bin` processes on Linux before conversion
- 5-minute timeout (300 seconds)
- Return `{ pdfPath: string }`
- Proper error messages when LibreOffice not found

**Future Work (not in this plan):** PowerPointStrategy using COM/AppleScript automation

---

## Phase 3: PDF to Image Processing

### Step 3.1: Implement PdfToImageConverter.js
Using `gm` (GraphicsMagick/ImageMagick) with bundled binaries:
```javascript
const gm = require('gm').subClass({
  imageMagick: true,
  appPath: getBundledImageMagickPath()  // Point to bundled binary
});
```

**Configure ImageMagick to find bundled Ghostscript:**
```javascript
// Set environment variables before conversion
process.env.MAGICK_CONFIGURE_PATH = path.join(bundledPath, 'etc');
process.env.GS_LIB = path.join(gsPath, 'lib');
// Windows-specific:
process.env.GS_DLL = path.join(gsPath, 'bin', 'gsdll64.dll');
```

For each page in PDF:
1. Render at 150 DPI density
2. Resize to 1920x1080 with letterboxing (black background)
3. Save as `slide_NNN.jpg` (3-digit zero-padded)
4. JPEG quality 92
5. Emit progress after each page

**Alternative approach** (more control): Call Ghostscript directly for PDF→PNG, then use sharp for resize:
```javascript
// Step 1: Ghostscript renders PDF pages to PNG
execFile(gsPath, [
  '-dNOPAUSE', '-dBATCH', '-sDEVICE=png16m',
  '-r150', '-dTextAlphaBits=4', '-dGraphicsAlphaBits=4',
  `-sOutputFile=${outputDir}/page_%03d.png`,
  pdfPath
]);

// Step 2: sharp resizes and converts to JPEG
await sharp(pngPath)
  .resize(1920, 1080, { fit: 'contain', background: '#000000' })
  .jpeg({ quality: 92 })
  .toFile(jpegPath);
```

### Step 3.2: Implement ThumbnailGenerator.js
Using `sharp`:
```javascript
const sharp = require('sharp');
// For each slide_NNN.jpg:
await sharp(slidePath)
  .resize(300, null, { fit: 'inside' })
  .jpeg({ quality: 85 })
  .toFile(thumbPath);
```

---

## Phase 4: Text Extraction & Metadata

### Step 4.1: Implement TextExtractor.js
Using `pptxtojson` for slide-level text extraction:
```javascript
const { parse } = require('pptxtojson');

// Returns structured data with slides array
const result = await parse(pptxBuffer);
// result.slides[i].elements contains text shapes
```

For each slide, extract text from elements and return:
```javascript
[
  { text: "Full slide text", firstLine: "First meaningful line (>2 chars)" },
  ...
]
```

This gives slide-level control needed for accurate singer screen text display.

### Step 4.2: Implement metadata generation
Write `metadata.json` matching existing format exactly:
```json
{
  "sourceFile": "presentation.pptx",
  "originalFile": "/full/path/to/presentation.pptx",
  "slideCount": 42,
  "generatedAt": "2026-02-04T10:30:00.000Z",
  "convertedAt": "2026-02-04T10:30:00.000Z",
  "slides": [
    { "text": "Full text content", "firstLine": "First meaningful line" }
  ]
}
```

---

## Phase 5: Main Converter & Integration

### Step 5.1: Implement Converter.js (Orchestrator)
```javascript
class Converter extends EventEmitter {
  async convert(inputPath, outputDir, options) {
    // 1. Auto-detect strategy if not specified
    // 2. Convert PPTX → PDF
    // 3. Convert PDF → JPEGs (with progress)
    // 4. Generate thumbnails
    // 5. Extract text from PPTX
    // 6. Write metadata.json
    // 7. Cleanup temp PDF
    // Return { success, slideCount, outputDir }
  }
}
```

Progress reporting: `this.emit('progress', { percent, stage })`

### Step 5.2: Implement index.js
Export function matching what main.js expects:
```javascript
module.exports = { Converter, PlatformDetector, convert };
```

### Step 5.3: Modify main.js
**Remove:**
- `getPythonPath()` function (lines 105-136)
- `getResourcePath()` calls for Python (line 615)
- Python spawn logic in `runConversion()` (lines 611-692)

**Replace with:**
```javascript
const { Converter } = require('./src/services/converter');

async function runConversion(filePath, language) {
  const converter = new Converter({
    width: CONFIG.displayWidth,
    height: CONFIG.displayHeight,
    thumbnailWidth: CONFIG.thumbnailWidth
  });

  converter.on('progress', ({ percent }) => {
    controlWindow?.webContents.send('conversion:progress', { language, progress: percent });
  });

  const outputDir = path.join(CONFIG.cacheDir, language);
  return await converter.convert(filePath, outputDir);
}
```

---

## Phase 6: Cleanup & Migration

### Step 6.1: Remove Python files
- Delete `python/` directory entirely
- Delete `python-embed/` directory if exists

### Step 6.2: Remove Python setup scripts
- Delete `scripts/setup-python-embed.ps1`
- Delete `scripts/setup-python-mac.sh`
- Delete `scripts/setup-python-linux.sh`

### Step 6.3: Update package.json
**Remove scripts:**
```json
"setup-python": "...",
"setup-python-embed": "...",
"setup-python-embed:mac": "...",
"setup-python-embed:linux": "...",
"convert": "python python/converter.py"
```

**Add new scripts:**
```json
"setup-imagemagick": "node scripts/setup-imagemagick.js",
"setup-ghostscript": "node scripts/setup-ghostscript.js",
"setup-deps": "npm run setup-imagemagick && npm run setup-ghostscript"
```

**Update electron-builder config:**
```json
"extraResources": [
  // REMOVE python and python-embed entries
  // ADD platform-specific bundled binaries:
],
"win": {
  "extraResources": [
    { "from": "imagemagick-embed/win32-x64", "to": "imagemagick-embed/win32-x64" },
    { "from": "ghostscript-embed/win32-x64", "to": "ghostscript-embed/win32-x64" }
  ]
},
"mac": {
  "extraResources": [
    { "from": "imagemagick-embed/darwin-${arch}", "to": "imagemagick-embed/darwin-${arch}" },
    { "from": "ghostscript-embed/darwin-${arch}", "to": "ghostscript-embed/darwin-${arch}" }
  ]
},
"linux": {
  "extraResources": [
    { "from": "imagemagick-embed/linux-x64", "to": "imagemagick-embed/linux-x64" },
    { "from": "ghostscript-embed/linux-x64", "to": "ghostscript-embed/linux-x64" }
  ]
},
"asarUnpack": [
  "imagemagick-embed/**",
  "ghostscript-embed/**"
]
```

### Step 6.4: Update documentation
- Update `CLAUDE.md` - remove Python references, document bundled dependencies
- Update `README.md` - update installation instructions (only LibreOffice needed)
- Update `.github/copilot-instructions.md` - update build commands

### Step 6.5: Update .gitignore
Add entries for bundled binaries (downloaded, not committed):
```
imagemagick-embed/
ghostscript-embed/
```

---

## Files to Modify

| File | Action |
|------|--------|
| `main.js` | Remove Python code, integrate Node.js converter |
| `package.json` | Add deps, remove Python scripts, update extraResources |
| `CLAUDE.md` | Update documentation |
| `README.md` | Update system requirements |
| `.github/copilot-instructions.md` | Update commands |

## Files to Create

| File | Purpose |
|------|---------|
| `src/services/converter/index.js` | Entry point |
| `src/services/converter/Converter.js` | Main orchestrator |
| `src/services/converter/strategies/BaseStrategy.js` | Abstract base (allows future strategies) |
| `src/services/converter/strategies/LibreOfficeStrategy.js` | LibreOffice implementation |
| `src/services/converter/PdfToImageConverter.js` | Uses bundled ImageMagick+Ghostscript |
| `src/services/converter/TextExtractor.js` | PPTX text extraction via `pptxtojson` |
| `src/services/converter/ThumbnailGenerator.js` | Thumbnail generation via `sharp` |
| `src/services/converter/PlatformDetector.js` | Auto-detection of LibreOffice + bundled tools |
| `scripts/setup-imagemagick.js` | Downloads ImageMagick portable for current platform |
| `scripts/setup-ghostscript.js` | Downloads Ghostscript for current platform |

**Directories created by setup scripts:**
| Directory | Contents |
|-----------|----------|
| `imagemagick-embed/win32-x64/` | ImageMagick Windows binaries |
| `imagemagick-embed/darwin-x64/` | ImageMagick macOS Intel binaries |
| `imagemagick-embed/darwin-arm64/` | ImageMagick macOS Apple Silicon binaries |
| `imagemagick-embed/linux-x64/` | ImageMagick Linux binaries |
| `ghostscript-embed/win32-x64/` | Ghostscript Windows binaries |
| `ghostscript-embed/darwin-x64/` | Ghostscript macOS Intel binaries |
| `ghostscript-embed/darwin-arm64/` | Ghostscript macOS Apple Silicon binaries |
| `ghostscript-embed/linux-x64/` | Ghostscript Linux binaries |

**Future (not in this plan):**
| `src/services/converter/strategies/PowerPointStrategy.js` | PowerPoint impl (can be added later) |

## Files to Delete

| File/Directory | Reason |
|----------------|--------|
| `python/` | Entire directory - replaced by Node.js |
| `python-embed/` | No longer needed |
| `scripts/setup-python-embed.ps1` | No longer needed |
| `scripts/setup-python-mac.sh` | No longer needed |
| `scripts/setup-python-linux.sh` | No longer needed |

---

## External Dependencies (User Must Install)

1. **LibreOffice** - https://www.libreoffice.org/download/ (for PPTX → PDF conversion)

**Bundled with app (no user installation required):**
- ImageMagick 7.x portable
- Ghostscript 10.x

---

## Verification Plan

### Manual Testing Checklist
- [ ] Setup scripts download correct binaries for each platform
- [ ] Bundled ImageMagick executes correctly
- [ ] Bundled Ghostscript executes correctly
- [ ] ImageMagick finds bundled Ghostscript for PDF processing
- [ ] LibreOffice detection on Windows/macOS/Linux
- [ ] PPTX → PDF conversion works
- [ ] PDF → JPEG conversion produces correct output
- [ ] Slide naming: `slide_001.jpg`, `slide_002.jpg`, etc.
- [ ] Thumbnail naming: `slide_001_thumb.jpg`, etc.
- [ ] Image quality matches (JPEG 92 slides, 85 thumbnails)
- [ ] Text extraction works with Cyrillic characters
- [ ] `metadata.json` format is correct
- [ ] Progress bar updates in UI
- [ ] Singer screen displays text correctly
- [ ] Conversion queue works (sequential conversions)
- [ ] Error handling for missing LibreOffice
- [ ] Packaged app works with bundled binaries (test on fresh machine)

### Compare Output
- Convert same PPTX with Python converter and Node.js converter
- Compare: file names, image dimensions, metadata.json structure

---

## Session Breakdown (Estimated)

| Session | Phases | Deliverable |
|---------|--------|-------------|
| 1 | Phase 1 (1.1-1.3) | Directory structure, npm deps, setup scripts for ImageMagick/Ghostscript |
| 2 | Phase 1 (1.4-1.5) | PlatformDetector, BaseStrategy |
| 3 | Phase 2 | LibreOfficeStrategy implementation |
| 4 | Phase 3 | PdfToImageConverter (with bundled IM+GS), ThumbnailGenerator |
| 5 | Phase 4 | TextExtractor, metadata generation |
| 6 | Phase 5 | Converter orchestrator, main.js integration |
| 7 | Phase 6 | Cleanup Python, update docs, final testing |

Each session can be executed independently. If a session completes early, the next session's work can begin. The plan is designed so that incomplete sessions can be resumed.

**Note:** Sessions may be combined if progress is faster than expected.
