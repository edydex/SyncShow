# SyncDisplay - Synchronized Bilingual Presentation System

A high-performance Windows desktop application for displaying bilingual presentations (Russian/English) on multiple screens simultaneously with zero-lag synchronization. Designed for church services and live events.

## Features

- **Dual-Screen Synchronized Display**: Show Russian and English slides on separate projectors in perfect sync
- **Fast PPTX Conversion**: Automatically converts PowerPoint files to optimized JPEG images
- **Professional Control Panel**: Grid view of all slides with thumbnails, easy navigation
- **Singer Screen Support**: Optional third display showing preview of upcoming slide text
- **Keyboard Shortcuts**: Navigate with arrow keys, space bar, Home/End keys
- **Hardware Accelerated**: Uses GPU rendering for smooth, lag-free display

## System Requirements

- **OS**: Windows 10 or Windows 11 (64-bit)
- **RAM**: 8 GB minimum, 16 GB recommended
- **Storage**: SSD recommended for fast image loading
- **Displays**: 2-4 display outputs (HDMI, DisplayPort, or VGA)
- **Software**: 
  - Node.js 18+ 
  - Python 3.9+
  - LibreOffice (for high-quality PPTX conversion)

## Installation

### Step 1: Install Prerequisites

1. **Install Node.js** (v18 or later)
   - Download from https://nodejs.org/
   - Choose the LTS version

2. **Install Python** (v3.9 or later)
   - Download from https://www.python.org/downloads/
   - ✅ Check "Add Python to PATH" during installation

3. **Install LibreOffice** (Required for best conversion quality)
   - Download from https://www.libreoffice.org/download/
   - Install with default options
   - LibreOffice path is auto-detected

### Step 2: Setup the Application

```powershell
# Navigate to the project directory
cd sync_display

# Install Node.js dependencies
npm install

# Install Python dependencies
pip install -r python/requirements.txt
```

### Step 3: Run the Application

```powershell
npm start
```

For development with DevTools:
```powershell
npm run dev
```

## Usage Guide

### Quick Start

1. **Launch the application** - Run `npm start`
2. **Select PowerPoint files**:
   - Click "Browse..." for Russian presentation
   - Click "Browse..." for English presentation
   - Wait for conversion (progress bar shows status)
3. **Assign displays**:
   - Select which monitor shows Russian slides
   - Select which monitor shows English slides
   - Optionally select a Singer Screen monitor
4. **Click "Start"** to begin the presentation

### During Presentation

| Action | Keyboard Shortcut |
|--------|-------------------|
| Next slide | → (Right Arrow) or Space |
| Previous slide | ← (Left Arrow) |
| First slide | Home |
| Last slide | End |
| Hide displays | Escape |
| Jump to slide | Click thumbnail in control panel |

### Tips for Best Results

1. **Prepare presentations** with matching slide counts in both languages
2. **Test on venue hardware** before the service
3. **Use 16:9 aspect ratio** for best display quality
4. **Close other applications** to maximize performance

## Project Structure

```
sync_display/
├── main.js                 # Electron main process
├── preload.js              # Secure IPC bridge
├── package.json            # Node.js configuration
├── src/
│   └── renderer/
│       ├── index.html      # Control panel UI
│       ├── styles.css      # Control panel styles
│       ├── app.js          # Control panel logic
│       ├── display.html    # Presentation display
│       ├── display.js      # Display logic
│       └── singer.html     # Singer screen
├── python/
│   ├── requirements.txt    # Python dependencies
│   └── converter.py        # PPTX to JPEG converter
└── cache/                  # Converted images (auto-created)
```

## Troubleshooting

### "LibreOffice not found" error
- Ensure LibreOffice is installed
- If installed in non-standard location, the app will fall back to basic conversion

### Slides look different from PowerPoint
- This is due to font substitution. Install the same fonts used in your PPTX files on the presentation computer.

### Lag between displays
- Ensure both displays are connected directly (not through adapters if possible)
- Close resource-intensive applications
- Check that GPU drivers are up to date

### Black screen on display
- Click the display window to ensure it has focus
- Press Escape and restart the presentation
- Verify correct display is selected in settings

## Building for Distribution

To create a standalone installer:

```powershell
npm run build
```

This creates an installer in the `dist/` folder.

## License

MIT License - Free for church and non-profit use.

## Support

For issues or feature requests, please open a GitHub issue.
