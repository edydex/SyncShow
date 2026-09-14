# Copilot Instructions for SyncShow

## Build, Test, and Lint Commands

- **Start app (production):** `npm start`
- **Start app (dev mode):** `npm run dev`
- **Build for all platforms:** `npm run build:all`
- **Build for Windows:** `npm run build:win`
- **Build for Mac:** `npm run build:mac`
- **Build for Linux:** `npm run build:linux`
- **Generate app icon:** `npm run generate-icon`
- **Syntax check:** `npm run check`
- **Regression tests:** `npm test`
- **Packaged PDF/native/legal evidence smoke:** `npm run build:verify-pdf-engine`
- **Public-release legal gate:** `npm run build:verify-release-legal`

## High-Level Architecture

- **Electron Main Process** orchestrates:
  - File management (PPTX import, image cache)
  - Slide navigation (current index, history)
  - Display coordination (screen detection, window management)
- **IPC Message Bus** connects main process to renderer windows:
  - **Display #1 (Russian)**: Borderless window, hardware-accelerated
  - **Display #2 (English)**: Borderless window, hardware-accelerated
  - **Singer Screen**: Shows current slide image and preview of next slide text
- **Node.js Converter** (`src/services/converter/`) handles PPTX to JPEG conversion:
  - Uses LibreOffice (headless) for PPTX → PDF
  - Uses the shared PDF.js + native canvas adapter for bounded PDF rendering
  - Uses sharp for rendered PNG → JPEG and thumbnails
  - Uses pptxtojson for text extraction
- **Control Panel (Renderer)** provides grid view, navigation, and display assignment

## Key Conventions

- **Configurable roles:** Russian, English, and Singers are starter-profile defaults; saved venue Profiles own input/output names, routing, previews, and display assignments
- **Slide navigation:** Keyboard shortcuts (arrows, space, Home/End) for fast control
- **Display clearing:** All displays can be blacked out via control panel or API
- **Fade transitions:** Configurable fade duration for slide changes
- **Sync mode:** Experimental feature for exact reveal timing across displays
- **Singer screen:** Can use a supplied deck, mirror another role, derive current/next text, or be disabled per service
- **Community service plans:** Keep import separate from explicit required-item preparation. Preparation is exact Community-read-only, main-token-owned, cursor-preserving, and must end in a fresh review without opening a project or entering Load/Show
- **App icon generation:** Use `scripts/generate-icon.js` for consistent branding
- **Release boundary:** QA packages include a blocked-status target-specific legal-evidence bundle. Never bypass the release gate or call it complete corresponding-source/relinking evidence.

## Converter Module

The converter is in `src/services/converter/`:
- **Converter.js** - Main orchestrator with EventEmitter for progress
- **strategies/LibreOfficeStrategy.js** - PPTX→PDF using LibreOffice
- **PdfEngine.js** - shared bounded PDF.js render/text adapter
- **PdfToImageConverter.js** - PDF.js page PNG→JPEG using sharp
- **ThumbnailGenerator.js** - 300px thumbnails via sharp
- **TextExtractor.js** - Slide text extraction via pptxtojson
- **PlatformDetector.js** - Detects LibreOffice and bundled tools

---

For more details, see [ARCHITECTURE.md](../ARCHITECTURE.md) and [README.md](../README.md).
