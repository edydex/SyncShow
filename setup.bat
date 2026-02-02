@echo off
echo ==========================================
echo SyncDisplay - Quick Setup Script
echo ==========================================
echo.

REM Check for Node.js
where node >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Node.js is not installed or not in PATH
    echo Please install Node.js from https://nodejs.org/
    pause
    exit /b 1
)
echo [OK] Node.js found: 
node --version

REM Check for Python
where python >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Python is not installed or not in PATH
    echo Please install Python from https://www.python.org/
    pause
    exit /b 1
)
echo [OK] Python found:
python --version

REM Check for LibreOffice
if exist "C:\Program Files\LibreOffice\program\soffice.exe" (
    echo [OK] LibreOffice found
) else if exist "C:\Program Files (x86)\LibreOffice\program\soffice.exe" (
    echo [OK] LibreOffice found (x86)
) else (
    echo [WARNING] LibreOffice not found in default location
    echo High-quality conversion requires LibreOffice
    echo Download from: https://www.libreoffice.org/download/
)

echo.
echo ==========================================
echo Installing Node.js dependencies...
echo ==========================================
call npm install
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Failed to install Node.js dependencies
    pause
    exit /b 1
)

echo.
echo ==========================================
echo Installing Python dependencies...
echo ==========================================
pip install -r python\requirements.txt
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Failed to install Python dependencies
    pause
    exit /b 1
)

echo.
echo ==========================================
echo Setup Complete!
echo ==========================================
echo.
echo To start the application, run:
echo   npm start
echo.
echo Or for development mode:
echo   npm run dev
echo.
pause
