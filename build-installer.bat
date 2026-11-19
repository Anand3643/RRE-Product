@echo off
setlocal
cd /d "%~dp0"
title Packaging RRE Tally Windows Installer...

echo ========================================================
echo       BUILDING RRE TALLY STANDALONE INSTALLER
echo ========================================================
echo.
echo Compiling Windows NSIS Installer (.exe) and Portable App...
npm run build:win

echo.
echo ========================================================
echo Packaging Complete! Check the "dist/" folder.
echo ========================================================
echo.
pause
