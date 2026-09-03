# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

SyncShow is a local-first church presentation controller with configurable inputs and outputs, a native editor, optional PowerPoint/Google Drive/Heritage Community adapters, and a Prepare → Load → Show workflow. Russian, English, and Singers remain only the safe starter profile. Do not describe synchronization as zero-lag or frame-perfect without a measured venue test.

## Build and Run Commands

```bash
npm start              # Run app (production)
npm run dev            # Run app with DevTools open
npm run build          # Build for current platform
npm run build:win      # Windows NSIS installer
npm run build:mac -- --arm64  # macOS DMG/ZIP for Apple Silicon
npm run build:mac -- --x64    # macOS DMG/ZIP for Intel
npm run build:linux    # Linux AppImage + deb
npm run build:all      # Build all platforms
npm run check          # Syntax-check every JavaScript source
npm test               # Node regression suite
npm run build:verify-pdf-engine   # Smoke exact packaged runtime/native target
npm run build:verify-release-legal # Fail closed while native legal blockers remain
```

Run the repository test/check scripts before packaging; see `package.json` for the current commands.

## Architecture

```
┌─────────────────────────────────────────────┐
│  ELECTRON MAIN PROCESS (main.js)            │
│  - File management & slide caching          │
│  - Slide navigation & app state             │
│  - Display coordination & window management │
│  - IPC message bus                          │
└─────────────────────────────────────────────┘
         │
         ├─────────────────┬─────────────┬──────────────┐
         ▼                 ▼             ▼              ▼
   ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
   │ CONTROL PANEL│  │  DISPLAY #1  │  │  DISPLAY #2  │  │ SINGER SCREEN│
   │ (Renderer)   │  │  (Russian)   │  │  (English)   │  │ (Text Preview)│
   │ index.html   │  │ display.html │  │ display.html │  │ singer.html  │
   │ app.js       │  │ display.js   │  │ display.js   │  │ singer.js    │
   └──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘
         │
      ┌──▼────────────────────────────┐
      │  NODE.JS CONVERTER            │
      │  src/services/converter/      │
      │  PPTX → PDF (PowerPoint/LO)   │
      │  PDF → JPEG (PDF.js + sharp) │
      │  Thumbnails (sharp)           │
      │  Text extraction (pptxtojson) │
      └───────────────────────────────┘
```

**Key entry points:**
- `main.js` - Electron main process, window management, IPC handlers
- `preload.js` - Secure IPC bridge using contextBridge
- `src/renderer/app.js` - Control panel logic
- `src/renderer/display.js` - Presentation display rendering
- `src/services/converter/` - Node.js PPTX to JPEG conversion module

## Converter Module

The converter (`src/services/converter/`) handles PPTX to JPEG conversion:

- **Converter.js** - Main orchestrator (EventEmitter for progress)
- **strategies/PowerPointStrategy.js** - Preferred Windows PPTX→PDF path when Microsoft PowerPoint is installed
- **strategies/LibreOfficeStrategy.js** - Isolated PPTX→PDF fallback on Windows and converter on macOS/Linux
- **PdfEngine.js** - shared bounded PDF.js render/text adapter using the explicit native canvas target
- **PdfToImageConverter.js** - PDF.js page PNG→JPEG using sharp
- **ThumbnailGenerator.js** - Generates 300px thumbnails
- **TextExtractor.js** - Extracts slide text using pptxtojson
- **PlatformDetector.js** - Selects PowerPoint first on Windows, otherwise LibreOffice

## Key Conventions

- **Configurable roles:** Input/output names, counts, routing, previews, and display assignments come from the saved venue Profile; Russian, English, and Singers are defaults rather than product limits
- **Slide navigation:** Keyboard shortcuts (arrows, space, Home/End) for fast control — handled in the renderer (`app.js`) via `document keydown`, active only when the control panel window is focused
- **Escape:** Clears all displays to black
- **Note:** Electron `globalShortcut` (OS-wide key capture) was intentionally removed. It caused accidental slide navigation when the app was not in focus during a live show. The commented-out code remains in `main.js` for reference.
- **Fade transitions:** Configurable fade duration (300ms default)
- **Thumbnail zoom:** Adjustable thumbnail grid size (50%–200%), persisted in user settings
- **Singer screen:** Can show a supplied deck, mirror another deck, derive upcoming text, or be disabled for one service; its operator preview is enabled by default
- **Sync mode:** Experimental best-effort coordinated reveal timing across displays
- **Community service plans:** Import and **Prepare required plan items** are separate explicit actions. Preparation may only point-read main-owned exact song/sermon pins, must return a fresh plan review, and must never write Community, advance feeds, import/open a project, or enter Load/Show

## IPC Communication

The app uses Electron IPC with context isolation. Key channels defined in `preload.js`:
- `dialog:openPptx`, `pptx:convert` - File operations
- `slide:navigate`, `slide:next`, `slide:prev` - Navigation
- `display:start`, `display:stop`, `display:clear` - Display control
- `settings:load`, `settings:save` - Persistence

## Platform-Specific Notes

- **Linux:** Keep Chromium sandboxing enabled by default. `--no-sandbox` is an explicit troubleshooting fallback only.
- **macOS:** QA builds are currently ad-hoc signed, not Developer ID signed or notarized
- **Windows:** Prefers Microsoft PowerPoint and falls back to LibreOffice
- **macOS/Linux:** Requires LibreOffice for PPTX→PDF conversion

## Packaging and Release Boundary

- `scripts/afterPack.js` generates a target-specific legal-evidence directory
  outside ASAR for every platform; macOS plist edits remain macOS-only.
- `scripts/verify-packaged-pdf-engine.js` rejects MuPDF, wrong native
  canvas/sharp targets, missing legal evidence, and packaged-runtime PDF drift.
- `scripts/verify-release-legal.js` currently must fail with
  `RELEASE_LEGAL_BLOCKED`. Do not bypass it or describe QA packages as
  distributable releases; canvas/Skia, sharp/libvips, and Electron/FFmpeg still
  need exact corresponding-source and practical relinking materials.

## Unverified Performance Targets

These values are historical goals, not guarantees. Record hardware, converter, deck, resolution, and actual measurements before publishing a performance claim.

| Operation | Target |
|-----------|--------|
| PPTX Import (130 slides) | < 60 seconds |
| Slide transition | < 16ms (one frame) |
| Inter-display sync | < 5ms variance |

## Dependencies

- **Runtime:** Electron v43.2, Node.js v22.13+ for development (CI uses Node 24); PowerPoint or LibreOffice as described above
- **npm packages:** pdfjs-dist, @napi-rs/canvas, sharp, pptxtojson
