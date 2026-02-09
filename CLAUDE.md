# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

SyncShow is a synchronized bilingual presentation display system for church services. It enables real-time dual-screen presentation of Russian and English PowerPoint slides simultaneously with zero-lag synchronization. Supports 2-4 displays including an optional "Singer Screen" for text preview.

## Build and Run Commands

```bash
npm start              # Run app (production)
npm run dev            # Run app with DevTools open
npm run build          # Build for current platform
npm run build:win      # Windows NSIS installer
npm run build:mac      # macOS DMG (universal)
npm run build:linux    # Linux AppImage + deb
npm run build:all      # Build all platforms
```

**Note:** No test or lint scripts are currently configured.

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
      │  PPTX → PDF (LibreOffice)     │
      │  PDF → JPEG (MuPDF + sharp)  │
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
- **strategies/LibreOfficeStrategy.js** - PPTX→PDF using LibreOffice headless
- **PdfToImageConverter.js** - PDF→JPEG using MuPDF (WASM) + sharp
- **ThumbnailGenerator.js** - Generates 300px thumbnails
- **TextExtractor.js** - Extracts slide text using pptxtojson
- **PlatformDetector.js** - Detects LibreOffice

## Key Conventions

- **Language separation:** Russian and English presentations are managed independently with separate caches and display assignments
- **Slide navigation:** Keyboard shortcuts (arrows, space, Home/End) for fast control
- **Escape:** Clears all displays to black
- **Fade transitions:** Configurable fade duration (300ms default)
- **Singer screen:** Always shows preview of next slide text
- **Sync mode:** Experimental feature for exact reveal timing across displays

## IPC Communication

The app uses Electron IPC with context isolation. Key channels defined in `preload.js`:
- `dialog:openPptx`, `pptx:convert` - File operations
- `slide:navigate`, `slide:next`, `slide:prev` - Navigation
- `display:start`, `display:stop`, `display:clear` - Display control
- `settings:load`, `settings:save` - Persistence

## Platform-Specific Notes

- **Linux:** `scripts/afterPack.js` adds `--no-sandbox` wrapper to fix sandbox issues
- **macOS:** Unsigned app requires Gatekeeper bypass (right-click → Open)
- **All platforms:** Requires LibreOffice for PPTX→PDF conversion

## Performance Targets

| Operation | Target |
|-----------|--------|
| PPTX Import (130 slides) | < 60 seconds |
| Slide transition | < 16ms (one frame) |
| Inter-display sync | < 5ms variance |

## Dependencies

- **Runtime:** Electron v28, Node.js v18+, LibreOffice
- **npm packages:** sharp, pptxtojson, mupdf
