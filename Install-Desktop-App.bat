@echo off
setlocal
cd /d "%~dp0"
title Installing TallyPrime Gold Desktop Application...

echo ========================================================
echo       TALLYPRIME GOLD - DESKTOP INSTALLATION
echo ========================================================
echo.
if exist "%~dp0dist\TallyPrime Gold Setup 1.0.0.exe" (
    echo [1/2] Running Windows Application Installer...
    "%~dp0dist\TallyPrime Gold Setup 1.0.0.exe" /S
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
echo   %%LOCALAPPDATA%%\Programs\TallyPrime Gold\TallyPrime Gold.exe
echo.
echo You can now launch "TallyPrime Gold" directly from:
echo   1. Your Windows Desktop ("TallyPrime Gold.lnk")
echo   2. Your Windows Start Menu ("TallyPrime Gold")
echo ========================================================
echo.
pause
