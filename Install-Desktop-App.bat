@echo off
setlocal
cd /d "%~dp0"
title Installing TallyPrime Gold Desktop Application...

echo ========================================================
echo       TALLYPRIME GOLD — DESKTOP INSTALLATION
echo ========================================================
echo.
echo Installing desktop shortcuts and native launchers...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0create-shortcuts.ps1"

echo.
echo ========================================================
echo Installation Successful!
echo You can now launch "TallyPrime Gold" directly from:
echo   1. Your Windows Desktop
echo   2. Your Windows Start Menu
echo ========================================================
echo.
pause
