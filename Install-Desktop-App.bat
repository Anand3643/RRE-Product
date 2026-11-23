@echo off
setlocal
cd /d "%~dp0"
title Installing RRE Entries Desktop Application...

echo ========================================================
echo       RRE ENTRIES - DESKTOP INSTALLATION
echo ========================================================
echo.
if exist "%~dp0dist\RRE Entries Setup 1.0.0.exe" (
    echo [1/2] Running Windows Application Installer...
    "%~dp0dist\RRE Entries Setup 1.0.0.exe" /S
    echo Installer completed successfully.
) else if exist "%~dp0dist\RRE Tally Setup 1.0.0.exe" (
    echo [1/2] Running Windows Application Installer...
    "%~dp0dist\RRE Tally Setup 1.0.0.exe" /S
    echo Installer completed successfully.
) else (
    echo [1/2] Standalone package ready.
)

echo.
echo [2/2] Updating Desktop and Start Menu shortcuts...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0create-shortcuts.ps1"

echo.
echo ========================================================
echo Installation Successful!
echo Application is installed at:
echo   %%LOCALAPPDATA%%\Programs\RRE Entries\RRE Entries.exe
echo.
echo You can now launch "RRE Entries" directly from:
echo   1. Your Windows Desktop ("RRE Entries.lnk")
echo   2. Your Windows Start Menu ("RRE Entries")
echo ========================================================
echo.
pause
