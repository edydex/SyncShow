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

**Python setup (bundled Python for production):**
```bash
npm run setup-python-embed:mac    # macOS
npm run setup-python-embed        # Windows (PowerShell)
npm run setup-python-embed:linux  # Linux
```

**Manual PPTX conversion:**
```bash
npm run convert
python python/converter.py --input <file.pptx> --output <dir> --width <w> --height <h>
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
      ┌──▼──────────────────┐
      │  PYTHON CONVERTER    │
      │  converter.py        │
      │  (PPTX → JPEG)       │
      │  LibreOffice preferred│
      │  PyMuPDF fallback    │
      └─────────────────────┘
```

**Key entry points:**
- `main.js` - Electron main process, window management, IPC handlers
- `preload.js` - Secure IPC bridge using contextBridge
- `src/renderer/app.js` - Control panel logic
- `src/renderer/display.js` - Presentation display rendering
- `python/converter.py` - PPTX to JPEG conversion engine

## Key Conventions

- **Language separation:** Russian and English presentations are managed independently with separate caches and display assignments
- **Slide navigation:** Keyboard shortcuts (arrows, space, Home/End) for fast control
- **Double-tap Escape:** Single press clears to black, double press (within 500ms) hides displays
- **Fade transitions:** Configurable fade duration (300ms default)
- **Singer screen:** Always shows preview of next slide text
- **Sync mode:** Experimental feature for exact reveal timing across displays
- **Windows encoding:** Console encoding set for Unicode/Cyrillic support in converter

## IPC Communication

The app uses Electron IPC with context isolation. Key channels defined in `preload.js`:
- `dialog:openPptx`, `pptx:convert` - File operations
- `slide:navigate`, `slide:next`, `slide:prev` - Navigation
- `display:start`, `display:stop`, `display:clear` - Display control
- `settings:load`, `settings:save` - Persistence

## Platform-Specific Notes

- **Linux:** `scripts/afterPack.js` adds `--no-sandbox` wrapper to fix sandbox issues
- **macOS:** Unsigned app requires Gatekeeper bypass (right-click → Open)
- **All platforms:** Requires LibreOffice for high-fidelity PPTX conversion

## Performance Targets

| Operation | Target |
|-----------|--------|
| PPTX Import (130 slides) | < 60 seconds |
| Slide transition | < 16ms (one frame) |
| Inter-display sync | < 5ms variance |

## Dependencies

- **Runtime:** Electron v28, Node.js v18+, Python v3.9+, LibreOffice
- **Python packages:** python-pptx, Pillow, pdf2image, PyMuPDF (see `python/requirements.txt`)
