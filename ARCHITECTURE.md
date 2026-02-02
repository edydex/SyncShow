# Synchronized Bilingual Presentation Display System

## Technical Architecture Document

### Overview
This application provides synchronized dual-screen presentation display for bilingual church services, showing Russian and English slides simultaneously on separate projectors with zero-lag synchronization.

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           ELECTRON MAIN PROCESS                          │
│  ┌─────────────────┐  ┌──────────────────┐  ┌─────────────────────────┐ │
│  │  File Manager   │  │  Slide Navigator │  │   Display Coordinator   │ │
│  │  - PPTX Import  │  │  - Current Index │  │  - Screen Detection     │ │
│  │  - Image Cache  │  │  - History       │  │  - Window Management    │ │
│  └────────┬────────┘  └────────┬─────────┘  └───────────┬─────────────┘ │
│           │                    │                        │               │
│           └────────────────────┼────────────────────────┘               │
│                                │                                         │
│                    ┌───────────▼───────────┐                            │
│                    │    IPC Message Bus    │                            │
│                    │  (Named Pipes/Sockets)│                            │
│                    └───────────┬───────────┘                            │
└────────────────────────────────┼────────────────────────────────────────┘
                                 │
        ┌────────────────────────┼────────────────────────┐
        │                        │                        │
        ▼                        ▼                        ▼
┌───────────────┐    ┌───────────────────┐    ┌───────────────────┐
│  Display #1   │    │    Display #2     │    │   Singer Screen   │
│  (Russian)    │    │    (English)      │    │  (Text Preview)   │
│               │    │                   │    │                   │
│ ┌───────────┐ │    │ ┌───────────────┐ │    │ ┌───────────────┐ │
│ │ Borderless│ │    │ │   Borderless  │ │    │ │   Text Only   │ │
│ │  Window   │ │    │ │    Window     │ │    │ │   Preview     │ │
│ │  (GDI+)   │ │    │ │    (GDI+)     │ │    │ │               │ │
│ └───────────┘ │    │ └───────────────┘ │    │ └───────────────┘ │
└───────────────┘    └───────────────────┘    └───────────────────┘
```

---

## Component Details

### 1. PPTX Processor (Python)
**Purpose:** Convert PowerPoint files to optimized JPEG images

**Technology Stack:**
- `python-pptx` for text extraction
- `LibreOffice` CLI (soffice) for high-fidelity PPTX → PDF → JPEG conversion
- `Pillow` for image optimization

**Process Flow:**
1. User selects PPTX file
2. LibreOffice converts PPTX to PDF (preserves fonts/formatting)
3. PDF pages converted to JPEG images at 1920x1080 resolution
4. Images stored in cache directory with naming convention: `{presentation_id}/slide_{number:03d}.jpg`
5. Text extracted and stored in JSON metadata file

**Performance Considerations:**
- Pre-render all slides during import (no runtime conversion)
- Cache images at target display resolution
- Use JPEG quality 90% for good quality/size balance
- Generate thumbnails (300x169) for control panel

### 2. Display Engine (Electron + Native)
**Purpose:** Render slides on multiple screens with zero lag

**Approach: Borderless Electron Windows with Hardware Acceleration**
- Create frameless BrowserWindows positioned on each display
- Use `will-change: transform` and GPU compositing
- Preload next/previous slides in hidden elements
- Synchronize via IPC with timestamp validation

**Key Features:**
- Instant slide transitions (pre-loaded images)
- Fullscreen borderless windows
- Black background for clean display
- Hardware-accelerated rendering

### 3. Control Panel (Electron Renderer)
**Purpose:** Provide operator interface for slide management

**Features:**
- Grid view of slide thumbnails (both languages side-by-side)
- Current slide highlight with border
- Previous 3 and next 3 slides visible
- Click-to-jump navigation
- Keyboard shortcuts (Arrow keys, Space, Home, End)
- Display assignment dropdowns
- Presenter notes preview

### 4. Synchronization Strategy
**Critical Requirement:** Both displays must update within 16ms of each other

**Implementation:**
1. Control panel sends `GOTO_SLIDE` message with slide number and timestamp
2. Both display windows receive message simultaneously via IPC
3. Images already preloaded in memory
4. CSS opacity transition (instant, no animation delay)
5. Optional: Use `requestAnimationFrame` for frame-perfect sync

### 5. Singer Screen Module
**Purpose:** Show text preview of upcoming slide for singers/readers

**Implementation:**
- Separate window on third display (if available)
- Extract first line of text from next slide
- Large, readable font (minimum 48pt)
- Auto-scroll for long text
- Dark theme (white text on black background)

---

## File Structure

```
sync_display/
├── package.json                 # Electron app config
├── main.js                      # Electron main process
├── preload.js                   # Secure IPC bridge
├── src/
│   ├── renderer/
│   │   ├── index.html           # Control panel HTML
│   │   ├── styles.css           # UI styles
│   │   ├── app.js               # Control panel logic
│   │   ├── display.html         # Presentation display window
│   │   └── display.js           # Display window logic
│   ├── services/
│   │   ├── slideManager.js      # Slide state management
│   │   ├── displayCoordinator.js # Multi-screen coordination
│   │   └── fileManager.js       # File operations
│   └── utils/
│       └── ipcChannels.js       # IPC channel constants
├── python/
│   ├── requirements.txt         # Python dependencies
│   ├── converter.py             # PPTX → JPEG converter
│   └── text_extractor.py        # Slide text extraction
├── cache/                       # Converted images (gitignored)
└── README.md                    # Setup instructions
```

---

## Performance Benchmarks (Targets)

| Operation | Target Time |
|-----------|-------------|
| PPTX Import (130 slides) | < 60 seconds |
| Slide transition | < 16ms (one frame) |
| Inter-display sync | < 5ms variance |
| Control panel response | < 50ms |
| Image load time | < 100ms |

---

## Hardware Requirements

- Windows 10/11 64-bit
- 8GB RAM minimum (16GB recommended)
- Dedicated GPU with multiple outputs OR USB display adapters
- SSD for image cache (faster loading)
- 2-4 display outputs

---

## Security Considerations

- Node integration disabled in renderer
- Context isolation enabled
- IPC communication uses validated channels
- Local files only (no network dependencies during presentation)

---

## Fallback Strategies

1. **LibreOffice unavailable:** Fall back to python-pptx basic rendering
2. **GPU acceleration disabled:** Use software rendering
3. **Display detection fails:** Manual display position input
4. **Image load failure:** Show placeholder with slide number

---

## Future Enhancements (Phase 2)

- Live PPTX editing detection and refresh
- Wireless remote control via mobile app
- Recording/streaming integration
- Multiple language support (beyond 2)
- Presentation scheduling/playlist
- Auto-advance timer mode
