# Setup Python Embeddable for SyncShow
# This script downloads Python embeddable and installs required packages

$ErrorActionPreference = "Stop"

$PYTHON_VERSION = "3.11.9"
$PYTHON_URL = "https://www.python.org/ftp/python/$PYTHON_VERSION/python-$PYTHON_VERSION-embed-amd64.zip"
$GET_PIP_URL = "https://bootstrap.pypa.io/get-pip.py"

$PROJECT_ROOT = $PSScriptRoot
if ($PROJECT_ROOT -match "scripts$") {
    $PROJECT_ROOT = Split-Path -Parent $PROJECT_ROOT
}
if (-not $PROJECT_ROOT -or $PROJECT_ROOT -eq "") {
    $PROJECT_ROOT = (Get-Location).Path
}
$EMBED_DIR = Join-Path $PROJECT_ROOT "python-embed"

Write-Host "Setting up Python Embeddable for SyncShow..." -ForegroundColor Cyan
Write-Host "Project root: $PROJECT_ROOT"
Write-Host "Embed directory: $EMBED_DIR"

# Create directory
if (Test-Path $EMBED_DIR) {
    Write-Host "Removing existing python-embed folder..."
    Remove-Item -Recurse -Force $EMBED_DIR
}
New-Item -ItemType Directory -Path $EMBED_DIR | Out-Null

# Download Python embeddable
$zipPath = Join-Path $env:TEMP "python-embed.zip"
Write-Host "Downloading Python $PYTHON_VERSION embeddable..." -ForegroundColor Yellow
Invoke-WebRequest -Uri $PYTHON_URL -OutFile $zipPath

# Extract
Write-Host "Extracting Python..."
Expand-Archive -Path $zipPath -DestinationPath $EMBED_DIR -Force
Remove-Item $zipPath

# Enable pip by modifying python311._pth
$pthFile = Join-Path $EMBED_DIR "python311._pth"
if (Test-Path $pthFile) {
    Write-Host "Enabling pip in python311._pth..."
    $content = Get-Content $pthFile
    # Uncomment import site
    $content = $content -replace '#import site', 'import site'
    # Add Lib\site-packages
    $content += "Lib\site-packages"
    Set-Content $pthFile $content
}

# Download and run get-pip.py
$getPipPath = Join-Path $EMBED_DIR "get-pip.py"
Write-Host "Downloading pip..." -ForegroundColor Yellow
Invoke-WebRequest -Uri $GET_PIP_URL -OutFile $getPipPath

$pythonExe = Join-Path $EMBED_DIR "python.exe"
Write-Host "Installing pip..."
& $pythonExe $getPipPath --no-warn-script-location
Remove-Item $getPipPath

# Install required packages
Write-Host "Installing required Python packages..." -ForegroundColor Yellow
$packages = @("Pillow", "PyMuPDF", "python-pptx")

foreach ($pkg in $packages) {
    Write-Host "  Installing $pkg..."
    & $pythonExe -m pip install $pkg --no-warn-script-location --quiet
}

# Verify installation
Write-Host "`nVerifying installation..." -ForegroundColor Cyan
& $pythonExe -c "import PIL; import fitz; import pptx; print('All packages installed successfully!')"

# Calculate size
$size = (Get-ChildItem $EMBED_DIR -Recurse | Measure-Object -Property Length -Sum).Sum / 1MB
Write-Host "`nPython embeddable setup complete!" -ForegroundColor Green
Write-Host "Size: $([math]::Round($size, 2)) MB"
Write-Host "Location: $EMBED_DIR"
