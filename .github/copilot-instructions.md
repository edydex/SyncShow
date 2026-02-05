# Copilot Instructions for SyncShow

## Build, Test, and Lint Commands

- **Start app (production):** `npm start`
- **Start app (dev mode):** `npm run dev`
- **Build for all platforms:** `npm run build:all`
- **Build for Windows:** `npm run build:win`
- **Build for Mac:** `npm run build:mac`
- **Build for Linux:** `npm run build:linux`
- **Generate app icon:** `npm run generate-icon`
- **Setup Python dependencies:** `npm run setup-python`
- **Convert PPTX to JPEG (manual):** `npm run convert`
- **Run Python converter directly:** `python python/converter.py --input <file.pptx> --output <dir> --width <w> --height <h>`

> **Note:** No test or lint scripts are currently defined in package.json. Add them if needed.

## High-Level Architecture

- **Electron Main Process** orchestrates:
  - File management (PPTX import, image cache)
  - Slide navigation (current index, history)
  - Display coordination (screen detection, window management)
- **IPC Message Bus** connects main process to renderer windows:
  - **Display #1 (Russian)**: Borderless window, hardware-accelerated
  - **Display #2 (English)**: Borderless window, hardware-accelerated
  - **Singer Screen**: Shows current slide image and preview of next slide text
- **Python Converter** handles PPTX to JPEG conversion, preferring LibreOffice, with PyMuPDF/pdf2image fallback
- **Control Panel (Renderer)** provides grid view, navigation, and display assignment

## Key Conventions

- **Language separation:** Russian and English presentations are managed independently, with separate caches and display assignments
- **Slide navigation:** Keyboard shortcuts (arrows, space, Home/End) for fast control
- **Display clearing:** All displays can be blacked out via control panel or API
- **Fade transitions:** Configurable fade duration for slide changes
- **Sync mode:** Experimental feature for exact reveal timing across displays
- **Singer screen:** Always shows preview of next slide text for singers
- **App icon generation:** Use `scripts/generate-icon.js` for consistent branding
- **Python encoding fix:** Windows console encoding is set for Unicode (Cyrillic) support in converter

---

For more details, see [ARCHITECTURE.md](../ARCHITECTURE.md) and [README.md](../README.md).
