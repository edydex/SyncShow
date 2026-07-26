@echo off
echo ==========================================
echo SyncShow - Quick Setup Script
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

REM Check for a supported Windows presentation converter.
REM SyncShow prefers Microsoft PowerPoint when it is installed and falls back
REM to LibreOffice. Python is no longer required.
where POWERPNT.EXE >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    echo [OK] Microsoft PowerPoint found
) else if exist "C:\Program Files\Microsoft Office\root\Office16\POWERPNT.EXE" (
    echo [OK] Microsoft PowerPoint found
) else if exist "C:\Program Files (x86)\Microsoft Office\root\Office16\POWERPNT.EXE" (
    echo [OK] Microsoft PowerPoint found (x86)
) else (
    goto check_libreoffice
)
goto converter_found

:check_libreoffice
if exist "C:\Program Files\LibreOffice\program\soffice.exe" (
    echo [OK] LibreOffice found
) else if exist "C:\Program Files (x86)\LibreOffice\program\soffice.exe" (
    echo [OK] LibreOffice found (x86)
) else (
    echo [WARNING] Neither Microsoft PowerPoint nor LibreOffice was found
    echo Install either PowerPoint or LibreOffice before converting presentations.
    echo LibreOffice download: https://www.libreoffice.org/download/
)

:converter_found

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
