#!/bin/bash
# Setup Python for SyncShow on macOS
# Downloads standalone Python and installs required packages

set -e

PYTHON_VERSION="3.11.9"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
EMBED_DIR="$PROJECT_ROOT/python-embed"

echo "Setting up Python for SyncShow on macOS..."
echo "Project root: $PROJECT_ROOT"
echo "Embed directory: $EMBED_DIR"

# Clean up existing
if [ -d "$EMBED_DIR" ]; then
    echo "Removing existing python-embed folder..."
    rm -rf "$EMBED_DIR"
fi
mkdir -p "$EMBED_DIR"

# Detect architecture
ARCH=$(uname -m)
if [ "$ARCH" = "arm64" ]; then
    echo "Detected Apple Silicon (arm64)"
    PYTHON_URL="https://www.python.org/ftp/python/${PYTHON_VERSION}/python-${PYTHON_VERSION}-macos11.pkg"
else
    echo "Detected Intel (x86_64)"
    PYTHON_URL="https://www.python.org/ftp/python/${PYTHON_VERSION}/python-${PYTHON_VERSION}-macos11.pkg"
fi

# We'll use python-build-standalone for a portable Python
# This is a better approach than the official installer
STANDALONE_VERSION="20240107"
if [ "$ARCH" = "arm64" ]; then
    STANDALONE_URL="https://github.com/indygreg/python-build-standalone/releases/download/${STANDALONE_VERSION}/cpython-${PYTHON_VERSION}+${STANDALONE_VERSION}-aarch64-apple-darwin-install_only.tar.gz"
else
    STANDALONE_URL="https://github.com/indygreg/python-build-standalone/releases/download/${STANDALONE_VERSION}/cpython-${PYTHON_VERSION}+${STANDALONE_VERSION}-x86_64-apple-darwin-install_only.tar.gz"
fi

echo "Downloading standalone Python..."
TEMP_FILE="/tmp/python-standalone.tar.gz"
curl -L -o "$TEMP_FILE" "$STANDALONE_URL"

echo "Extracting Python..."
tar -xzf "$TEMP_FILE" -C "$EMBED_DIR"
rm "$TEMP_FILE"

# The extracted folder is named 'python', move contents up
if [ -d "$EMBED_DIR/python" ]; then
    mv "$EMBED_DIR/python"/* "$EMBED_DIR/"
    rmdir "$EMBED_DIR/python"
fi

PYTHON_BIN="$EMBED_DIR/bin/python3"

# Verify Python works
echo "Verifying Python installation..."
"$PYTHON_BIN" --version

# Upgrade pip
echo "Upgrading pip..."
"$PYTHON_BIN" -m pip install --upgrade pip --quiet

# Install required packages
echo "Installing required Python packages..."
"$PYTHON_BIN" -m pip install Pillow PyMuPDF python-pptx --quiet

# Verify packages
echo ""
echo "Verifying installation..."
"$PYTHON_BIN" -c "import PIL; import fitz; import pptx; print('All packages installed successfully!')"

# Calculate size
SIZE=$(du -sh "$EMBED_DIR" | cut -f1)
echo ""
echo "Python setup complete!"
echo "Size: $SIZE"
echo "Location: $EMBED_DIR"
echo "Python binary: $PYTHON_BIN"
