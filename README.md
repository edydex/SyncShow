# SyncShow - Synchronized Bilingual Presentation System

A high-performance cross-platform desktop application for displaying bilingual presentations (Russian/English) on multiple screens simultaneously with zero-lag synchronization. Designed for church services and live events.

## Features

- **Dual-Screen Synchronized Display**: Show Russian and English slides on separate projectors in perfect sync
- **Fast PPTX Conversion**: Automatically converts PowerPoint files to optimized JPEG images
- **Professional Control Panel**: Grid view of all slides with thumbnails, easy navigation
- **Singer Screen Support**: Optional third display showing preview of upcoming slide text
- **Keyboard Shortcuts**: Navigate with arrow keys, space bar, Home/End keys
- **Hardware Accelerated**: Uses GPU rendering for smooth, lag-free display

## System Requirements

- **OS**: Windows 10/11, macOS 11+ (Intel & Apple Silicon), or Linux
- **RAM**: 8 GB minimum, 16 GB recommended
- **Storage**: SSD recommended for fast image loading
- **Displays**: 2-4 display outputs (HDMI, DisplayPort, or VGA)
- **Software**: [LibreOffice](https://www.libreoffice.org/download/) (required for PowerPoint conversion)

## Installation

### Download Pre-built Releases

Download the latest installer for your platform from the [Releases page](https://github.com/edydex/SyncShow/releases):

- **Windows**: `SyncShow Setup X.X.X.exe`
- **macOS**: `SyncShow-X.X.X-universal.dmg` (Intel & Apple Silicon)
- **Linux**: `SyncShow-X.X.X.AppImage` or `.deb`

### macOS Installation

1. **Download** the `.dmg` file from [Releases](https://github.com/edydex/SyncShow/releases)
2. **Open** the DMG file
3. **Drag** SyncShow to the Applications folder
4. **First launch** - You may see "SyncShow can't be opened because Apple cannot check it for malicious software"

   **To bypass Gatekeeper** (required for unsigned apps):
   - **Option 1**: Right-click (or Control-click) on SyncShow in Applications → click **Open** → click **Open** in the dialog
   - **Option 2**: Go to **System Settings → Privacy & Security** → scroll down and click **Open Anyway**
   - **Option 3**: Run in Terminal:
     ```bash
     xattr -cr /Applications/SyncShow.app
     ```

5. **Install LibreOffice** from https://www.libreoffice.org/download/

### Windows Installation

1. Download the `.exe` installer from [Releases](https://github.com/edydex/SyncShow/releases)
2. Run the installer and follow the prompts
3. Install [LibreOffice](https://www.libreoffice.org/download/)

### Linux Installation

1. Download the `.AppImage` or `.deb` from [Releases](https://github.com/edydex/SyncShow/releases)
2. For AppImage: 
   ```bash
   chmod +x SyncShow-*.AppImage
   ./SyncShow-*.AppImage
   ```
3. For deb: `sudo dpkg -i SyncShow-*.deb`
4. Install LibreOffice: `sudo apt install libreoffice`

**Troubleshooting Linux**: If you see a sandbox error, run with:
```bash
./SyncShow-*.AppImage --no-sandbox
```

---

## Development Setup

If you want to run from source or contribute:

### Prerequisites

1. **Node.js** (v18 or later) - https://nodejs.org/
2. **Python** (v3.9 or later) - https://www.python.org/downloads/
3. **LibreOffice** - https://www.libreoffice.org/download/

### Setup the Application

```bash
# Clone the repository
git clone https://github.com/edydex/SyncShow.git
cd SyncShow

# Install Node.js dependencies
npm install

# Setup bundled Python (recommended)
# macOS:
npm run setup-python-embed:mac

# Windows (PowerShell):
npm run setup-python-embed

# Linux:
npm run setup-python-embed:linux
```

### Run the Application

```bash
npm start
```

For development with DevTools:
```bash
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
